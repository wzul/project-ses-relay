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
        raw_email LONGTEXT NOT NULL,
        status ENUM('pending', 'sent', 'failed') DEFAULT 'pending',
        retries INT DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      )
    `);
  } finally {
    connection.release();
  }
}

export default pool;
