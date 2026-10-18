import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { claimBatch, markFailed, markSent, cleanupQueue, sqlTimestamp, QueueItem } from './db';

const sesClient = new SESv2Client({
  region: process.env.AWS_REGION || 'ap-southeast-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const MAX_RETRIES = 3;
const BATCH_SIZE = Number(process.env.QUEUE_BATCH_SIZE || 10);

/** Exponential backoff: 2, 5, 10 minutes for retries 0, 1, 2 */
function backoffDate(retries: number): string {
  const minutes = Math.pow(retries + 1, 2) + 1;
  return sqlTimestamp(new Date(Date.now() + minutes * 60_000));
}

function withEnvelopeHeaders(item: QueueItem, raw: Buffer): Buffer {
  let out = Buffer.concat([Buffer.from(`X-Tenant-ID: ${item.tenant_tag}\r\n`), raw]);
  const asString = out.toString('utf-8');

  if (!/^To:/im.test(asString)) {
    const firstLineEnd = out.indexOf('\r\n');
    out =
      firstLineEnd !== -1
        ? Buffer.concat([
            out.subarray(0, firstLineEnd + 2),
            Buffer.from(`To: ${item.envelope_to}\r\n`),
            out.subarray(firstLineEnd + 2),
          ])
        : Buffer.concat([out, Buffer.from(`\r\nTo: ${item.envelope_to}\r\n`)]);
  }

  if (!/^From:/im.test(asString)) {
    const firstLineEnd = out.indexOf('\r\n');
    out =
      firstLineEnd !== -1
        ? Buffer.concat([
            out.subarray(0, firstLineEnd + 2),
            Buffer.from(`From: ${item.envelope_from}\r\n`),
            out.subarray(firstLineEnd + 2),
          ])
        : Buffer.concat([out, Buffer.from(`\r\nFrom: ${item.envelope_from}\r\n`)]);
  }

  return out;
}

let running = false;

export async function processQueue(): Promise<void> {
  if (running) return; // never overlap two poll cycles
  running = true;
  try {
    const batch = claimBatch(BATCH_SIZE, MAX_RETRIES);
    if (batch.length === 0) return;

    for (const item of batch) {
      try {
        const raw = withEnvelopeHeaders(item, Buffer.from(item.raw_email));

        const command = new SendEmailCommand({
          Content: { Raw: { Data: raw } },
          Destination: { ToAddresses: item.envelope_to.split(',') },
          ConfigurationSetName: item.configuration_set || undefined,
          // TenantName is not in the public SDK types yet.
          ...({ TenantName: item.tenant_tag } as object),
        });

        console.log(
          `Sending email ${item.id} for tenant ${item.tenant_tag} using config set: ${item.configuration_set || 'NONE'}`
        );
        await sesClient.send(command);
        markSent(item.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retries = item.retries + 1;
        console.error(`Failed to send email ${item.id} (attempt ${retries}/${MAX_RETRIES}):`, message);
        markFailed(item.id, retries, backoffDate(item.retries), message);
      }
    }
  } catch (err) {
    console.error('Queue processing error:', err);
  } finally {
    running = false;
  }
}

export function startWorker(): void {
  // Poll interval is configurable; a small relay does not need 5s granularity.
  const pollMs = Number(process.env.QUEUE_POLL_MS || 10_000);
  setInterval(() => void processQueue(), pollMs).unref();
  setInterval(() => {
    const removed = cleanupQueue();
    if (removed > 0) console.log(`Cleaned up ${removed} old queue rows`);
  }, 3_600_000).unref();
  void processQueue(); // drain anything left over from a restart immediately
}
