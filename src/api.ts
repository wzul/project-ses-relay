import express from 'express';
import bcrypt from 'bcrypt';
import pool from './db';
import crypto from 'crypto';

const router = express.Router();

// Middleware to check for Admin API Key
const authenticateAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apiKey = req.header('X-API-Key');
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    console.error('ADMIN_API_KEY is not set in environment variables');
    return res.status(500).json({ error: 'Internal server configuration error' });
  }

  if (apiKey !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

router.get('/verify', authenticateAdmin, (req, res) => {
  res.json({ success: true });
});

router.post('/tenants', authenticateAdmin, async (req, res) => {
  const { name, tenant_tag } = req.body;

  if (!name || !tenant_tag) {
    return res.status(400).json({ error: 'Name and tenant_tag are required' });
  }

  try {
    const smtp_username = `user_${crypto.randomBytes(4).toString('hex')}`;
    const smtp_password = crypto.randomBytes(12).toString('hex');
    const smtp_password_hash = await bcrypt.hash(smtp_password, 10);

    const [result] = await pool.query(
      'INSERT INTO tenants (name, smtp_username, smtp_password, smtp_password_hash, tenant_tag) VALUES (?, ?, ?, ?, ?)',
      [name, smtp_username, smtp_password, smtp_password_hash, tenant_tag]
    );

    res.status(201).json({
      id: (result as any).insertId,
      name,
      smtp_username,
      smtp_password,
      tenant_tag,
    });
  } catch (err) {
    console.error('Create tenant error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/tenants', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, smtp_username, smtp_password, tenant_tag, created_at FROM tenants');
    res.json(rows);
  } catch (err) {
    console.error('List tenants error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
