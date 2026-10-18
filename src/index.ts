import express from 'express';
import path from 'node:path';
import { createSmtpServer } from './smtp';
import { initDb } from './db';
import { startWorker } from './worker';
import apiRouter from './api';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.use('/api', apiRouter);

async function start(): Promise<void> {
  try {
    initDb();
    console.log(`Database initialised at ${process.env.DB_PATH || '/data/relay.db'}`);

    const apiPort = Number(process.env.API_PORT || 3000);
    app.listen(apiPort, () => console.log(`Management API listening on port ${apiPort}`));

    const smtpPort = Number(process.env.SMTP_PORT || 587);
    createSmtpServer().listen(smtpPort, () =>
      console.log(`SMTP Relay listening on port ${smtpPort}`)
    );

    startWorker();
    console.log('Background worker started');
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
