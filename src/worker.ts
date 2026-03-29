import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import pool from './db';
import { RowDataPacket } from 'mysql2';
import dotenv from 'dotenv';

dotenv.config();

const sesClient = new SESv2Client({
  region: process.env.AWS_REGION || 'ap-southeast-1',
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

const MAX_RETRIES = 3;

export async function processQueue() {
  const connection = await pool.getConnection();
  try {
    // 1. Atomic Locking: Mark emails as 'processing' so other worker instances don't pick them up
    // We pick 'pending' OR 'failed' that are due for retry
    const [lockResult] = await connection.query<any>(`
      UPDATE mail_queue 
      SET status = 'processing' 
      WHERE status IN ('pending', 'failed') 
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        AND retries < ?
      LIMIT 10
    `, [MAX_RETRIES]);

    if (lockResult.affectedRows === 0) {
      return;
    }

    // 2. Fetch the emails we just locked
    const [rows] = await connection.query<MailQueueItem[]>(`
      SELECT mq.*, t.tenant_tag, t.configuration_set 
      FROM mail_queue mq
      JOIN tenants t ON mq.tenant_id = t.id
      WHERE mq.status = 'processing'
    `);

    for (const item of rows) {
      try {
        let rawEmail = item.raw_email;
        
        // ... (header injection logic remains the same)
        const customHeader = Buffer.from(`X-Tenant-ID: ${item.tenant_tag}\r\n`);
        rawEmail = Buffer.concat([customHeader, rawEmail]);

        const rawEmailStr = rawEmail.toString('utf-8');

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
            rawEmail = Buffer.concat([
              rawEmail,
              Buffer.from(`\r\nTo: ${item.envelope_to}\r\n`)
            ]);
          }
        }

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
          // @ts-ignore
          TenantName: item.tenant_tag,
        });

        console.log(`Sending email ${item.id} for tenant ${item.tenant_tag} using config set: ${item.configuration_set || 'NONE'}`);
        await sesClient.send(command);

        // Success: Mark as sent
        await connection.query(
          'UPDATE mail_queue SET status = ?, retries = retries + 1 WHERE id = ?',
          ['sent', item.id]
        );
      } catch (err: any) {
        console.error(`Failed to send email ${item.id}:`, err);
        
        // Failure: Implement Exponential Backoff
        // Retry 1: 1 min, Retry 2: 5 min, Retry 3: 15 min
        const backoffMinutes = Math.pow(item.retries + 1, 2) + 1; 
        const nextRetry = new Date();
        nextRetry.setMinutes(nextRetry.getMinutes() + backoffMinutes);

        await connection.query(
          'UPDATE mail_queue SET status = ?, retries = retries + 1, next_retry_at = ?, error_message = ? WHERE id = ?',
          ['failed', nextRetry, err.message, item.id]
        );
      }
    }
  } catch (err) {
    console.error('Queue processing error:', err);
  } finally {
    connection.release();
  }
}

export async function cleanupQueue() {
  try {
    // Delete sent emails older than 7 days to keep DB lean
    const [result] = await pool.query<any>(
      "DELETE FROM mail_queue WHERE status = 'sent' AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)"
    );
    if (result.affectedRows > 0) {
      console.log(`Cleaned up ${result.affectedRows} old sent emails from queue`);
    }
  } catch (err) {
    console.error('Queue cleanup error:', err);
  }
}

export function startWorker() {
  setInterval(processQueue, 5000); // Poll every 5 seconds
  setInterval(cleanupQueue, 3600000); // Cleanup every hour
}
