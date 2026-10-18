#!/usr/bin/env node
/**
 * One-off migration: MariaDB `tenants` rows -> SQLite relay.db
 *
 * Usage:
 *   mariadb -u... -p... ses_relay -N -B -e \
 *     "select id,name,smtp_username,smtp_password,tenant_tag,ifnull(configuration_set,''),daily_limit from tenants" \
 *     | node scripts/migrate-from-mariadb.mjs /data/relay.db
 *
 * Reads tab-separated rows on stdin. Password hashes are recomputed with
 * scrypt (bcrypt is no longer a dependency), using the plaintext
 * smtp_password column so existing SMTP clients keep working unchanged.
 * mail_queue is intentionally NOT migrated: pending mail does not survive a
 * relay restart and past failures have no value.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';

const dbPath = process.argv[2] || process.env.DB_PATH || '/data/relay.db';

function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    smtp_username TEXT NOT NULL UNIQUE,
    smtp_password TEXT NOT NULL DEFAULT '',
    smtp_password_hash TEXT NOT NULL,
    tenant_tag TEXT NOT NULL,
    configuration_set TEXT,
    daily_limit INTEGER NOT NULL DEFAULT 1000,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS mail_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    envelope_to TEXT NOT NULL,
    envelope_from TEXT NOT NULL,
    raw_email BLOB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
    retries INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const insert = db.prepare(`
  INSERT INTO tenants (id, name, smtp_username, smtp_password, smtp_password_hash,
                       tenant_tag, configuration_set, daily_limit)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(smtp_username) DO UPDATE SET
    name = excluded.name,
    smtp_password = excluded.smtp_password,
    smtp_password_hash = excluded.smtp_password_hash,
    tenant_tag = excluded.tenant_tag,
    configuration_set = excluded.configuration_set,
    daily_limit = excluded.daily_limit
`);

const rl = createInterface({ input: process.stdin });
let count = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  const [id, name, username, password, tag, configSet, limit] = line.split('\t');
  if (!username) continue;
  insert.run(
    Number(id),
    name,
    username,
    password,
    hashPassword(password),
    tag,
    configSet || null,
    Number(limit) || 1000
  );
  count++;
}

db.close();
console.log(`Migrated ${count} tenant(s) into ${dbPath}`);
