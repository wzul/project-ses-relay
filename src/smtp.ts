import { SMTPServer, SMTPServerAuthenticationResponse } from 'smtp-server';
import { simpleParser } from 'mailparser';
import bcrypt from 'bcrypt';
import pool from './db';
import { RowDataPacket } from 'mysql2';
import fs from 'fs';
import path from 'path';

interface Tenant extends RowDataPacket {
  id: number;
  smtp_username: string;
  smtp_password: string;
  smtp_password_hash: string;
  tenant_tag: string;
  daily_limit: number;
}

export function createSmtpServer() {
  const domain = process.env.SMTP_DOMAIN;

  let keyPath = process.env.SMTP_KEY_PATH;
  let certPath = process.env.SMTP_CERT_PATH;

  // If SMTP_DOMAIN is set, prioritize Let's Encrypt paths
  if (domain && !keyPath) {
    keyPath = `/etc/letsencrypt/live/${domain}/privkey.pem`;
    certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  }

  // Fallback to default paths if still not set
  keyPath = keyPath || '/app/certs/server.key';
  certPath = certPath || '/app/certs/server.crt';

  let key, cert;
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      key = fs.readFileSync(keyPath);
      cert = fs.readFileSync(certPath);
      console.log(`Using SMTP certificates from ${keyPath}`);
    } else {
      console.warn(`SMTP certificates not found at ${keyPath}. Falling back to self-signed.`);
      const fallbackKey = '/app/certs/server.key';
      const fallbackCert = '/app/certs/server.crt';
      if (fs.existsSync(fallbackKey) && fs.existsSync(fallbackCert)) {
        key = fs.readFileSync(fallbackKey);
        cert = fs.readFileSync(fallbackCert);
      }
    }
  } catch (err) {
    console.error('Failed to load SMTP certificates:', err);
  }

  const server = new SMTPServer({
    secure: false, // STARTTLS will be used if key/cert are provided
    key,
    cert,
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, session, callback) {
      (async () => {
        try {
          const [rows] = await pool.query<Tenant[]>(
            'SELECT * FROM tenants WHERE smtp_username = ?',
            [auth.username]
          );

          if (rows.length === 0) {
            return callback(new Error('Invalid username or password'));
          }

          const tenant = rows[0];
          const isValid = await bcrypt.compare(auth.password || '', tenant.smtp_password_hash);

          if (!isValid) {
            return callback(new Error('Invalid username or password'));
          }

          // Store tenant info in session for onData
          (session as any).tenant = tenant;
          callback(null, { user: tenant.id.toString() });
        } catch (err) {
          console.error('Auth error:', err);
          callback(new Error('Internal server error'));
        }
      })();
    },
    onData(stream, session, callback) {
      (async () => {
        try {
          const tenant = (session as any).tenant as Tenant;
          if (!tenant) {
            return callback(new Error('Not authenticated'));
          }

          // Rate Limit Check
          const [countResult] = await pool.query<any[]>(
            'SELECT COUNT(*) as count FROM mail_queue WHERE tenant_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)',
            [tenant.id]
          );
          
          if (countResult[0].count >= tenant.daily_limit) {
            console.warn(`Tenant ${tenant.tenant_tag} exceeded daily limit of ${tenant.daily_limit}`);
            return callback(new Error(`Daily limit of ${tenant.daily_limit} emails exceeded`));
          }

          const chunks: Buffer[] = [];
          stream.on('data', (chunk) => {
            chunks.push(chunk);
          });

          stream.on('end', async () => {
            try {
              const rawEmail = Buffer.concat(chunks);
              const envelopeTo = session.envelope.rcptTo.map((r) => r.address).join(',');
              const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';

              await pool.query(
                'INSERT INTO mail_queue (tenant_id, envelope_to, envelope_from, raw_email, status) VALUES (?, ?, ?, ?, ?)',
                [tenant.id, envelopeTo, envelopeFrom, rawEmail, 'pending']
              );
              callback();
            } catch (err) {
              console.error('Queue error:', err);
              callback(new Error('Failed to queue email'));
            }
          });
        } catch (err) {
          console.error('Data error:', err);
          callback(new Error('Internal server error'));
        }
      })();
    },
  });

  server.on('error', (err) => {
    console.error('SMTP Server Error:', err.message);
  });

  return server;
}
