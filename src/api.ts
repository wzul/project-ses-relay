import express from 'express';
import crypto from 'node:crypto';
import { hashPassword } from './password';
import {
  createTenant,
  listTenants,
  pingDb,
  queueStats,
  updateTenant,
} from './db';

const router = express.Router();

const authenticateAdmin: express.RequestHandler = (req, res, next) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.error('ADMIN_API_KEY is not set in environment variables');
    res.status(500).json({ error: 'Internal server configuration error' });
    return;
  }
  if (req.header('X-API-Key') !== adminKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

router.get('/verify', authenticateAdmin, (_req, res) => {
  res.json({ success: true });
});

router.get('/health', (_req, res) => {
  try {
    pingDb();
    res.json({ status: 'healthy', database: 'connected' });
  } catch {
    res.status(500).json({ status: 'unhealthy', error: 'Database connection failed' });
  }
});

router.get('/stats', authenticateAdmin, (_req, res) => {
  try {
    res.json(queueStats());
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.post('/tenants', authenticateAdmin, (req, res) => {
  const { name, tenant_tag, configuration_set, daily_limit } = req.body ?? {};
  if (!name || !tenant_tag) {
    res.status(400).json({ error: 'Name and tenant_tag are required' });
    return;
  }

  try {
    const smtp_username = `user_${crypto.randomBytes(4).toString('hex')}`;
    const smtp_password = crypto.randomBytes(12).toString('hex');
    const id = createTenant({
      name,
      smtp_username,
      smtp_password,
      smtp_password_hash: hashPassword(smtp_password),
      tenant_tag,
      configuration_set: configuration_set || null,
      daily_limit: daily_limit || 1000,
    });

    res.status(201).json({
      id,
      name,
      smtp_username,
      smtp_password,
      tenant_tag,
      configuration_set: configuration_set || null,
      daily_limit: daily_limit || 1000,
    });
  } catch (err) {
    console.error('Create tenant error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/tenants', authenticateAdmin, (_req, res) => {
  try {
    res.json(listTenants());
  } catch (err) {
    console.error('List tenants error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/tenants/:id', authenticateAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { name, tenant_tag, configuration_set, daily_limit } = req.body ?? {};
  if (!Number.isInteger(id) || !name || !tenant_tag) {
    res.status(400).json({ error: 'Name and tenant_tag are required' });
    return;
  }

  try {
    updateTenant(id, {
      name,
      tenant_tag,
      configuration_set: configuration_set || null,
      daily_limit: daily_limit || 1000,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Update tenant error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
