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
}

export async function processQueue() {
  try {
    const [rows] = await pool.query<MailQueueItem[]>(`
      SELECT mq.*, t.tenant_tag 
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
          const firstLineEnd = rawEmail.indexOf('\r\n') + 2;
          rawEmail = Buffer.concat([
            rawEmail.subarray(0, firstLineEnd),
            Buffer.from(`To: ${item.envelope_to}\r\n`),
            rawEmail.subarray(firstLineEnd)
          ]);
        }

        // Ensure From: header exists
        if (!/^From:/im.test(rawEmailStr)) {
          const firstLineEnd = rawEmail.indexOf('\r\n') + 2;
          rawEmail = Buffer.concat([
            rawEmail.subarray(0, firstLineEnd),
            Buffer.from(`From: ${item.envelope_from}\r\n`),
            rawEmail.subarray(firstLineEnd)
          ]);
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
          EmailTags: [
            {
              Name: 'tenant_id',
              Value: item.tenant_tag,
            },
          ],
        });

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
