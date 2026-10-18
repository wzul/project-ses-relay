import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-file SQLite storage (node:sqlite, built into Node >= 22.5).
 * No external database process, no driver dependency.
 */

const DB_PATH = process.env.DB_PATH || '/data/relay.db';

let db: DatabaseSync | null = null;

export interface Tenant {
  id: number;
  name: string;
  smtp_username: string;
  smtp_password_hash: string;
  tenant_tag: string;
  configuration_set: string | null;
  daily_limit: number;
  created_at: string;
}

export interface QueueItem {
  id: number;
  tenant_id: number;
  envelope_to: string;
  envelope_from: string;
  raw_email: Uint8Array;
  retries: number;
  tenant_tag: string;
  configuration_set: string | null;
}

function conn(): DatabaseSync {
  if (!db) throw new Error('Database not initialised');
  return db;
}

/** SQLite-friendly UTC timestamp: YYYY-MM-DD HH:MM:SS */
export function sqlTimestamp(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function initDb(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

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

    CREATE INDEX IF NOT EXISTS idx_status_retry ON mail_queue (status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_tenant_created ON mail_queue (tenant_id, created_at);
  `);
}

export function findTenantByUsername(username: string): Tenant | undefined {
  return conn()
    .prepare('SELECT * FROM tenants WHERE smtp_username = ?')
    .get(username) as unknown as Tenant | undefined;
}

export function countQueuedLast24h(tenantId: number): number {
  const row = conn()
    .prepare(
      "SELECT COUNT(*) AS c FROM mail_queue WHERE tenant_id = ? AND created_at > datetime('now', '-24 hours')"
    )
    .get(tenantId) as unknown as { c: number };
  return row.c;
}

export function enqueue(item: {
  tenantId: number;
  to: string;
  from: string;
  raw: Uint8Array;
}): void {
  conn()
    .prepare(
      `INSERT INTO mail_queue (tenant_id, envelope_to, envelope_from, raw_email, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
    .run(item.tenantId, item.to, item.from, item.raw);
}

/**
 * Claim a batch for sending. BEGIN IMMEDIATE makes the select+update atomic,
 * so a second instance can never claim the same rows (replaces MySQL's
 * UPDATE ... LIMIT, which SQLite does not support).
 */
export function claimBatch(limit: number, maxRetries: number): QueueItem[] {
  const c = conn();
  c.exec('BEGIN IMMEDIATE');
  try {
    const rows = c
      .prepare(
        `SELECT mq.id, mq.tenant_id, mq.envelope_to, mq.envelope_from, mq.raw_email,
                mq.retries, t.tenant_tag, t.configuration_set
         FROM mail_queue mq
         JOIN tenants t ON t.id = mq.tenant_id
         WHERE mq.status IN ('pending', 'failed')
           AND (mq.next_retry_at IS NULL OR mq.next_retry_at <= datetime('now'))
           AND mq.retries < ?
         ORDER BY mq.id
         LIMIT ?`
      )
      .all(maxRetries, limit) as unknown as QueueItem[];

    if (rows.length > 0) {
      const mark = c.prepare("UPDATE mail_queue SET status = 'processing' WHERE id = ?");
      for (const r of rows) mark.run(r.id);
    }
    c.exec('COMMIT');
    return rows;
  } catch (err) {
    c.exec('ROLLBACK');
    throw err;
  }
}

export function markSent(id: number): void {
  conn().prepare("UPDATE mail_queue SET status = 'sent', error_message = NULL WHERE id = ?").run(id);
}

export function markFailed(id: number, retries: number, nextRetryAt: string, error: string): void {
  conn()
    .prepare(
      "UPDATE mail_queue SET status = 'failed', retries = ?, next_retry_at = ?, error_message = ? WHERE id = ?"
    )
    .run(retries, nextRetryAt, error.slice(0, 900), id);
}

export function cleanupQueue(sentDays = 7, failedDays = 30): number {
  const r = conn()
    .prepare(
      `DELETE FROM mail_queue
       WHERE (status = 'sent'   AND created_at < datetime('now', ?))
          OR (status = 'failed' AND retries >= 3 AND created_at < datetime('now', ?))`
    )
    .run(`-${sentDays} days`, `-${failedDays} days`);
  return Number(r.changes);
}

export function queueStats(): {
  counts: Record<string, number>;
  recent_errors: { error_message: string; created_at: string }[];
} {
  const c = conn();
  const rows = c
    .prepare('SELECT status, COUNT(*) AS count FROM mail_queue GROUP BY status')
    .all() as unknown as { status: string; count: number }[];
  const errors = c
    .prepare(
      "SELECT error_message, created_at FROM mail_queue WHERE status = 'failed' ORDER BY created_at DESC LIMIT 5"
    )
    .all() as unknown as { error_message: string; created_at: string }[];
  return {
    counts: rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: r.count }), {}),
    recent_errors: errors,
  };
}

export function listTenants(): Omit<Tenant, 'smtp_password_hash'>[] {
  return conn()
    .prepare(
      `SELECT id, name, smtp_username, smtp_password, tenant_tag,
              configuration_set, daily_limit, created_at
       FROM tenants ORDER BY id`
    )
    .all() as unknown as Omit<Tenant, 'smtp_password_hash'>[];
}

export function createTenant(t: {
  name: string;
  smtp_username: string;
  smtp_password: string;
  smtp_password_hash: string;
  tenant_tag: string;
  configuration_set: string | null;
  daily_limit: number;
}): number {
  const r = conn()
    .prepare(
      `INSERT INTO tenants (name, smtp_username, smtp_password, smtp_password_hash,
                            tenant_tag, configuration_set, daily_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.name,
      t.smtp_username,
      t.smtp_password,
      t.smtp_password_hash,
      t.tenant_tag,
      t.configuration_set,
      t.daily_limit
    );
  return Number(r.lastInsertRowid);
}

export function updateTenant(
  id: number,
  t: { name: string; tenant_tag: string; configuration_set: string | null; daily_limit: number }
): void {
  conn()
    .prepare(
      'UPDATE tenants SET name = ?, tenant_tag = ?, configuration_set = ?, daily_limit = ? WHERE id = ?'
    )
    .run(t.name, t.tenant_tag, t.configuration_set, t.daily_limit, id);
}

export function pingDb(): void {
  conn().prepare('SELECT 1 AS ok').get();
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
