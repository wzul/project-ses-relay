import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import pool from './db';
import { RowDataPacket } from 'mysql2';
import dotenv from 'dotenv';

dotenv.config();

const sesClient = new SESv2Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

interface MailQueueItem extends RowDataPacket {
  id: number;
  tenant_id: number;
  envelope_to: string;
  envelope_from: string;
  raw_email: Buffer;
  tenant_tag: string;
  configuration_set: string | null;
}

export async function processQueue() {
  try {
    const [rows] = await pool.query<MailQueueItem[]>(`
      SELECT mq.*, t.tenant_tag, t.configuration_set 
      FROM mail_queue mq
      JOIN tenants t ON mq.tenant_id = t.id
      WHERE mq.status = 'pending'
      LIMIT 10
    `);

    for (const item of rows) {
      try {
        let rawEmail = item.raw_email;
        
        // Add X-Tenant-ID header at the very beginning
        // We avoid X-SES- prefix as it might be reserved/stripped by AWS
        const customHeader = Buffer.from(`X-Tenant-ID: ${item.tenant_tag}\r\n`);
        rawEmail = Buffer.concat([customHeader, rawEmail]);

        const rawEmailStr = rawEmail.toString('utf-8');

        // Ensure To: header exists
        if (!/^To:/im.test(rawEmailStr)) {
          const firstLineEnd = rawEmail.indexOf('\r\n');
          if (firstLineEnd !== -1) {
            const insertPos = firstLineEnd + 2;
            rawEmail = Buffer.concat([
              rawEmail.subarray(0, insertPos),
              Buffer.from(`To: ${item.envelope_to}\r\n`),
              rawEmail.subarray(insertPos)
            ]);
          } else {
            // Fallback if no CRLF found
            rawEmail = Buffer.concat([
              rawEmail,
              Buffer.from(`\r\nTo: ${item.envelope_to}\r\n`)
            ]);
          }
        }

        // Ensure From: header exists
        if (!/^From:/im.test(rawEmailStr)) {
          const firstLineEnd = rawEmail.indexOf('\r\n');
          if (firstLineEnd !== -1) {
            const insertPos = firstLineEnd + 2;
            rawEmail = Buffer.concat([
              rawEmail.subarray(0, insertPos),
              Buffer.from(`From: ${item.envelope_from}\r\n`),
              rawEmail.subarray(insertPos)
            ]);
          }
        }

        const command = new SendEmailCommand({
          Content: {
            Raw: {
              Data: rawEmail,
            },
          },
          Destination: {
            ToAddresses: item.envelope_to.split(','),
          },
          ConfigurationSetName: item.configuration_set || undefined,
          // @ts-ignore - TenantName is a specific parameter for routing through tenant context
          TenantName: item.tenant_tag,
        });

        console.log(`Sending email ${item.id} for tenant ${item.tenant_tag} using config set: ${item.configuration_set || 'NONE'}`);
        await sesClient.send(command);

        await pool.query(
          'UPDATE mail_queue SET status = ?, retries = retries + 1 WHERE id = ?',
          ['sent', item.id]
        );
      } catch (err: any) {
        console.error(`Failed to send email ${item.id}:`, err);
        await pool.query(
          'UPDATE mail_queue SET status = ?, retries = retries + 1, error_message = ? WHERE id = ?',
          ['failed', err.message, item.id]
        );
      }
    }
  } catch (err) {
    console.error('Queue processing error:', err);
  }
}

export function startWorker() {
  setInterval(processQueue, 5000); // Poll every 5 seconds
}
