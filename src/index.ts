import express from 'express';
import path from 'path';
import { createSmtpServer } from './smtp';
import { initDb } from './db';
import { startWorker } from './worker';
import apiRouter from './api';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, '../public')));

// Fallback to index.html for the root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use('/api', apiRouter);

const smtpServer = createSmtpServer();

async function start() {
  try {
    await initDb();
    console.log('Database initialized');

    const apiPort = process.env.API_PORT || 3000;
    app.listen(apiPort, () => {
      console.log(`Management API listening on port ${apiPort}`);
    });

    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    smtpServer.listen(smtpPort, () => {
      console.log(`SMTP Relay listening on port ${smtpPort}`);
    });

    startWorker();
    console.log('Background worker started');
  } catch (err) {
    console.error('Failed to start application:', err);
    process.exit(1);
  }
}

start();
