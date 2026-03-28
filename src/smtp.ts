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
}

export function createSmtpServer() {
  const keyPath = process.env.SMTP_KEY_PATH || '/app/certs/server.key';
  const certPath = process.env.SMTP_CERT_PATH || '/app/certs/server.crt';
  const disableTls = process.env.SMTP_DISABLE_TLS === 'true';

  let key, cert;
  if (!disableTls) {
    try {
      if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        key = fs.readFileSync(keyPath);
        cert = fs.readFileSync(certPath);
        console.log(`Using SMTP certificates from ${keyPath} and ${certPath}`);
      } else {
        console.warn(`SMTP certificates not found at ${keyPath} or ${certPath}. Falling back to self-signed if available.`);
      }
    } catch (err) {
      console.error('Failed to load SMTP certificates:', err);
    }
  } else {
    console.log('SMTP TLS/STARTTLS is disabled');
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

          let rawEmail = '';
          stream.on('data', (chunk) => {
            rawEmail += chunk.toString();
          });

          stream.on('end', async () => {
            try {
              await pool.query(
                'INSERT INTO mail_queue (tenant_id, raw_email, status) VALUES (?, ?, ?)',
                [tenant.id, rawEmail, 'pending']
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

  return server;
}
