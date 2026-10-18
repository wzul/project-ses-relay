import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createSmtpServer, resolveCertPaths } from './smtp';
import { initDb } from './db';
import { startWorker } from './worker';
import { refreshSesGuard } from './sesguard';
import apiRouter from './api';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.use('/api', apiRouter);

const CERT_CHECK_MS = Number(process.env.CERT_CHECK_MS || 60_000);

function certStamp(): string {
  const { keyPath, certPath } = resolveCertPaths();
  try {
    return `${keyPath}:${fs.statSync(keyPath).mtimeMs}:${fs.statSync(certPath).mtimeMs}`;
  } catch {
    return `${keyPath}:missing`;
  }
}

/**
 * smtp-server reads key/cert once at construction, so a renewed certificate is not
 * picked up until the process restarts. The certbot sidecar cannot signal across
 * containers, so watch the files and exit(0): `restart: always` brings us back with
 * the new cert. Without this the relay keeps serving an expired certificate.
 */
function watchCertificates(stamp: string): void {
  setInterval(() => {
    const now = certStamp();
    if (now !== stamp && !now.endsWith('missing')) {
      console.log(`Certificate changed on disk (${now}), restarting to load it`);
      process.exit(0);
    }
  }, CERT_CHECK_MS).unref();
}

async function start(): Promise<void> {
  try {
    initDb();
    console.log(`Database initialised at ${process.env.DB_PATH || '/data/relay.db'}`);

    const apiPort = Number(process.env.API_PORT || 3000);
    app.listen(apiPort, () => console.log(`Management API listening on port ${apiPort}`));

    const smtpPort = Number(process.env.SMTP_PORT || 587);
    const smtpServer = createSmtpServer();
    smtpServer.listen(smtpPort, () => console.log(`SMTP Relay listening on port ${smtpPort}`));

    startWorker();
    console.log('Background worker started');

    watchCertificates(certStamp());

    await refreshSesGuard(true);
    setInterval(() => void refreshSesGuard(), 600_000).unref();
  } catch (err) {
    console.error('Failed to start application:', err);
    process.exit(1);
  }
}

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void start();
