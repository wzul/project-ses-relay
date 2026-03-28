import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'ses_relay',
  password: process.env.DB_PASSWORD || 'ses_relay_pass',
  database: process.env.DB_NAME || 'ses_relay',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function initDb() {
  let connection;
  let retries = 5;
  while (retries > 0) {
    try {
      connection = await pool.getConnection();
      break;
    } catch (err) {
      console.log(`Waiting for database... (${retries} retries left)`);
      retries -= 1;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  if (!connection) {
    throw new Error('Could not connect to database after multiple retries');
  }

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        smtp_username VARCHAR(255) UNIQUE NOT NULL,
        smtp_password VARCHAR(255) NOT NULL,
        smtp_password_hash VARCHAR(255) NOT NULL,
        tenant_tag VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS mail_queue (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        envelope_to TEXT NOT NULL,
        envelope_from VARCHAR(255) NOT NULL,
        raw_email LONGBLOB NOT NULL,
        status ENUM('pending', 'sent', 'failed') DEFAULT 'pending',
        retries INT DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      )
    `);

    // Simple migration: Add missing columns if table already existed
    const [columns] = await connection.query<any[]>('SHOW COLUMNS FROM mail_queue');
    const columnNames = columns.map((c: any) => c.Field);

    if (!columnNames.includes('envelope_to')) {
      await connection.query('ALTER TABLE mail_queue ADD COLUMN envelope_to TEXT NOT NULL AFTER tenant_id');
    }
    if (!columnNames.includes('envelope_from')) {
      await connection.query('ALTER TABLE mail_queue ADD COLUMN envelope_from VARCHAR(255) NOT NULL AFTER envelope_to');
    }
    if (!columnNames.includes('smtp_password')) {
      const [tenantCols] = await connection.query<any[]>('SHOW COLUMNS FROM tenants');
      const tenantColNames = tenantCols.map((c: any) => c.Field);
      if (!tenantColNames.includes('smtp_password')) {
        await connection.query('ALTER TABLE tenants ADD COLUMN smtp_password VARCHAR(255) NOT NULL AFTER smtp_username');
      }
      if (!tenantColNames.includes('configuration_set')) {
        await connection.query('ALTER TABLE tenants ADD COLUMN configuration_set VARCHAR(255) AFTER tenant_tag');
      }
    }

    // Ensure raw_email is LONGBLOB (in case it was LONGTEXT before)
    await connection.query('ALTER TABLE mail_queue MODIFY COLUMN raw_email LONGBLOB NOT NULL');

  } finally {
    connection.release();
  }
}

export default pool;
