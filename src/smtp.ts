import { SMTPServer, SMTPServerAuthenticationResponse } from 'smtp-server';
import { simpleParser } from 'mailparser';
import bcrypt from 'bcrypt';
import pool from './db';
import { RowDataPacket } from 'mysql2';

interface Tenant extends RowDataPacket {
  id: number;
  smtp_username: string;
  smtp_password_hash: string;
  tenant_tag: string;
}

export function createSmtpServer() {
  const server = new SMTPServer({
    secure: false, // STARTTLS will be used
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
