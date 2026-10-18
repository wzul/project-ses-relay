import { SMTPServer } from 'smtp-server';
import fs from 'node:fs';
import { findTenantByUsername, countQueuedLast24h, enqueue, Tenant } from './db';
import { verifyPassword } from './password';

export function createSmtpServer(): SMTPServer {
  const domain = process.env.SMTP_DOMAIN;

  let keyPath = process.env.SMTP_KEY_PATH;
  let certPath = process.env.SMTP_CERT_PATH;

  // If SMTP_DOMAIN is set, prioritise the Let's Encrypt paths.
  if (domain && !keyPath) {
    keyPath = `/etc/letsencrypt/live/${domain}/privkey.pem`;
    certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  }

  // Fallback to the self-signed pair baked into the image.
  const fallbackKey = '/app/certs/server.key';
  const fallbackCert = '/app/certs/server.crt';
  keyPath = keyPath || fallbackKey;
  certPath = certPath || fallbackCert;

  let key: Buffer | undefined;
  let cert: Buffer | undefined;
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      key = fs.readFileSync(keyPath);
      cert = fs.readFileSync(certPath);
      console.log(`Using SMTP certificates from ${keyPath}`);
    } else if (fs.existsSync(fallbackKey) && fs.existsSync(fallbackCert)) {
      console.warn(`SMTP certificates not found at ${keyPath}. Falling back to self-signed.`);
      key = fs.readFileSync(fallbackKey);
      cert = fs.readFileSync(fallbackCert);
    }
  } catch (err) {
    console.error('Failed to load SMTP certificates:', err);
  }

  const server = new SMTPServer({
    secure: false, // STARTTLS is offered when key/cert are loaded
    key,
    cert,
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, session, callback) {
      try {
        const tenant = findTenantByUsername(auth.username || '');
        if (!tenant || !verifyPassword(auth.password || '', tenant.smtp_password_hash)) {
          return callback(new Error('Invalid username or password'));
        }
        (session as unknown as { tenant: Tenant }).tenant = tenant;
        callback(null, { user: tenant.id.toString() });
      } catch (err) {
        console.error('Auth error:', err);
        callback(new Error('Internal server error'));
      }
    },
    onData(stream, session, callback) {
      const tenant = (session as unknown as { tenant?: Tenant }).tenant;
      if (!tenant) return callback(new Error('Not authenticated'));

      try {
        const used = countQueuedLast24h(tenant.id);
        if (used >= tenant.daily_limit) {
          console.warn(`Tenant ${tenant.tenant_tag} exceeded daily limit of ${tenant.daily_limit}`);
          return callback(new Error(`Daily limit of ${tenant.daily_limit} emails exceeded`));
        }
      } catch (err) {
        console.error('Rate limit check error:', err);
        return callback(new Error('Internal server error'));
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));

      stream.on('end', () => {
        try {
          const rawEmail = Buffer.concat(chunks);
          const envelopeTo = session.envelope.rcptTo.map((r) => r.address).join(',');
          const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';

          enqueue({ tenantId: tenant.id, to: envelopeTo, from: envelopeFrom, raw: rawEmail });
          callback();
        } catch (err) {
          console.error('Queue error:', err);
          callback(new Error('Failed to queue email'));
        }
      });
    },
  });

  server.on('error', (err: Error) => {
    console.error('SMTP Server Error:', err.message);
  });

  return server;
}
