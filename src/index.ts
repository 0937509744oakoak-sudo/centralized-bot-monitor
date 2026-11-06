import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import multer from 'multer';
import pkg from 'pg';
import WebSocket, { WebSocketServer } from 'ws';

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/bot_monitor_db'
});

const upload = multer();
const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;
const leaseMs = Number(process.env.ORDER_LEASE_MS || 30000);
const heartbeatTimeoutMs = Number(process.env.BOT_HEARTBEAT_TIMEOUT_MS || 15000);

app.use(express.json());

// WebSocket Server for Real-time Dashboard Broadcasting
const wss = new WebSocketServer({ server });
const clients = new Set<WebSocket>();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(event: string, data: any) {
  const payload = JSON.stringify({ event, data, at: new Date().toISOString() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Helper: Async Route Wrapper
function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function actor(req: Request): string {
  return (req.header('x-actor') as string) || 'operator';
}

async function audit(actorName: string, action: string, targetType: string, targetId: string, details: any) {
  try {
    await pool.query(
      'INSERT INTO audit_logs(actor, action, target_type, target_id, details) VALUES($1, $2, $3, $4, $5)',
      [actorName, action, targetType, targetId, details]
    );
  } catch (e) {
    console.error('Audit log failed:', e);
  }
}

async function getBot(id: string | number) {
  const r = await pool.query('SELECT * FROM oxide_bot_agents WHERE id = $1::bigint', [id]);
  return r.rows[0] || null;
}

async function issueCommand(botId: string | number, command: string, requestedBy: string, idempotencyKey: string) {
  const r = await pool.query(
    "INSERT INTO oxide_bot_commands(bot_id, command, requested_by, idempotency_key, status) VALUES($1, $2, $3, $4, 'pending') RETURNING *",
    [botId, command, requestedBy, idempotencyKey]
  );
  broadcast('bot.command', r.rows[0]);
  return r.rows[0];
}

async function simulatorCommand(botId: number, command: string) {
  // จำลองการสั่งการไปยังบอท
  return { ok: true, botId, command, executedAt: new Date().toISOString() };
}

async function refreshBots() {
  // ฟังก์ชันรีเฟรชสถานะบอทเบื้องต้น
}

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, service: 'central-bot-monitor' });
}));

app.get('/api/v1/overview', asyncRoute(async (_req, res) => {
  const [bots, orders, system] = await Promise.all([
    pool.query("SELECT count(*) FILTER(WHERE status='online' AND enabled) online_count, count(*) FILTER(WHERE status='online' AND enabled AND work_state='in_progress') active_count, count(*) FILTER(WHERE status='online' AND enabled AND work_state='standby') standby_count, count(*) FILTER(WHERE work_state='in_progress') in_progress_count, count(*) FILTER(WHERE status='offline' OR NOT enabled) offline_count FROM oxide_bot_agents"),
    pool.query("SELECT status, count(*)::int count FROM orders GROUP BY status"),
    pool.query("SELECT value FROM system_settings WHERE key='kill_switch'")
  ]);
  res.json({ bots: bots.rows[0], orders: orders.rows, killSwitch: system.rows[0]?.value?.enabled ?? false, at: new Date().toISOString() });
}));

app.get('/api/v1/bots', asyncRoute(async (_req, res) => {
  const r = await pool.query("SELECT b.*, (SELECT json_agg(c ORDER BY c.created_at DESC) FROM (SELECT id, command, status, created_at, completed_at FROM oxide_bot_commands WHERE bot_id=b.id ORDER BY created_at DESC LIMIT 5)c) recent_commands FROM oxide_bot_agents b ORDER BY b.id");
  res.json(r.rows);
}));

app.get('/api/v1/bots/:id', asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const b = await getBot(id);
  if (!b) return res.status(404).json({ error: 'bot_not_found' });
  const [logs, metrics, commands] = await Promise.all([
    pool.query('SELECT * FROM bot_logs WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 100', [b.id]),
    pool.query('SELECT * FROM bot_metrics WHERE bot_id=$1 ORDER BY captured_at DESC LIMIT 60', [b.id]),
    pool.query('SELECT * FROM oxide_bot_commands WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 20', [b.id])
  ]);
  res.json({ bot: b, logs: logs.rows, metrics: metrics.rows, commands: commands.rows });
}));

app.post('/api/v1/bots/:id/commands', asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const command = req.body?.command;
  if (!['start', 'stop', 'restart', 'status'].includes(command)) return res.status(400).json({ error: 'invalid_command' });
  if (!await getBot(id)) return res.status(404).json({ error: 'bot_not_found' });
  const key = (req.header('idempotency-key') as string) || randomUUID();
  const row = await issueCommand(id, command, actor(req), key);
  res.status(row.status === 'failed' ? 502 : 202).json(row);
}));

app.post('/api/v1/system/kill-switch', asyncRoute(async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  await pool.query("UPDATE system_settings SET value=jsonb_build_object('enabled',$1::boolean), updated_at=now() WHERE key='kill_switch'", [enabled]);
  await audit(actor(req), 'system.kill_switch', 'system', 'global', { enabled });
  broadcast('system.kill_switch', { enabled });
  if (enabled) {
    const bots = await pool.query("SELECT id FROM oxide_bot_agents WHERE enabled=true AND status='online'");
    for (const b of bots.rows) try { await issueCommand(b.id, 'stop', actor(req), `killswitch-${Date.now()}-${b.id}`) } catch (e) { console.error('Kill switch stop failed', b.id, e) }
  }
  res.json({ enabled });
}));

app.post('/api/v1/orders', asyncRoute(async (req, res) => {
  const { externalOrderId, amount = 0, currency = 'THB', payload = {} } = req.body || {};
  if (!externalOrderId || !Number.isFinite(Number(amount)) || Number(amount) < 0) return res.status(400).json({ error: 'invalid_order' });
  const key = (req.header('idempotency-key') as string) || req.body?.idempotencyKey || randomUUID();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ins = await c.query("INSERT INTO orders(external_order_id, idempotency_key, status, amount, currency, payload) VALUES($1, $2, 'PENDING_PAYMENT', $3, $4, $5) ON CONFLICT(external_order_id) DO NOTHING RETURNING *", [externalOrderId, key, amount, currency, payload]);
    let order = ins.rows[0];
    if (!order) { order = (await c.query('SELECT * FROM orders WHERE external_order_id=$1 FOR UPDATE', [externalOrderId])).rows[0]; }
    else await c.query("INSERT INTO order_events(order_id, event_type, payload) VALUES($1, 'created', $2)", [order.id, { externalOrderId }]);
    await c.query('COMMIT');
    res.status(ins.rowCount ? 201 : 200).json(order);
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}));

app.post('/api/v1/orders/:id/pay', asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const numeric = /^\d+$/.test(id);
    const q = numeric ? await c.query('SELECT * FROM orders WHERE id=$1::bigint OR external_order_id=$2 FOR UPDATE', [id, id]) : await c.query('SELECT * FROM orders WHERE external_order_id=$1 FOR UPDATE', [id]);
    if (!q.rowCount) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'order_not_found' }) }
    const o = q.rows[0];
    if (o.status === 'PENDING_PAYMENT') {
      await c.query("UPDATE orders SET status='QUEUED', updated_at=now() WHERE id=$1", [o.id]);
      await c.query("INSERT INTO order_events(order_id, event_type, payload) VALUES($1, 'payment_confirmed', $2)", [o.id, req.body || {}]);
    }
    await c.query('COMMIT');
    broadcast('order.updated', { id: o.id });
    res.json((await pool.query('SELECT * FROM orders WHERE id=$1', [o.id])).rows[0]);
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}));

app.get('/api/v1/orders', asyncRoute(async (req, res) => {
  const status = (req.query.status as string) || null;
  const r = await pool.query('SELECT * FROM orders WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT 200', [status]);
  res.json(r.rows);
}));

app.post('/api/v1/orders/claim', asyncRoute(async (req, res) => {
  const botId = req.body?.botId;
  if (!botId || !await getBot(botId)) return res.status(400).json({ error: 'invalid_bot' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const enabled = await c.query("SELECT value->>'enabled' enabled FROM system_settings WHERE key='kill_switch'");
    if (enabled.rows[0]?.enabled === 'true') { await c.query('ROLLBACK'); return res.status(409).json({ error: 'kill_switch_enabled' }) }
    const bot = await c.query("SELECT id FROM oxide_bot_agents WHERE id=$1 AND enabled AND status='online' FOR UPDATE", [botId]);
    if (!bot.rowCount) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'bot_unavailable' }) }
    const r = await c.query("SELECT * FROM orders WHERE status='QUEUED' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");
    if (!r.rowCount) { await c.query('COMMIT'); return res.status(204).end() }
    const order = r.rows[0];
    await c.query("UPDATE orders SET status='IN_PROGRESS', bot_id=$2, attempts=attempts+1, lease_expires_at=now()+($3::int*interval '1 millisecond'), updated_at=now() WHERE id=$1", [order.id, botId, leaseMs]);
    await c.query("UPDATE oxide_bot_agents SET work_state='in_progress', updated_at=now() WHERE id=$1", [botId]);
    await c.query("INSERT INTO order_events(order_id, event_type, payload) VALUES($1, 'claimed', $2)", [order.id, { botId }]);
    await c.query('COMMIT');
    broadcast('order.claimed', { orderId: order.id, botId });
    res.json({ ...order, status: 'IN_PROGRESS', bot_id: botId, attempts: order.attempts + 1 });
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}));

app.post('/api/v1/orders/:id/complete', asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const status = req.body?.status;
  if (!['COMPLETED', 'FAILED'].includes(status)) return res.status(400).json({ error: 'invalid_terminal_status' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const numeric = /^\d+$/.test(id);
    const q = numeric ? await c.query('SELECT * FROM orders WHERE id=$1::bigint OR external_order_id=$2 FOR UPDATE', [id, id]) : await c.query('SELECT * FROM orders WHERE external_order_id=$1 FOR UPDATE', [id]);
    if (!q.rowCount) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'order_not_found' }) }
    const o = q.rows[0];
    if (o.status !== 'IN_PROGRESS') { await c.query('ROLLBACK'); return res.status(409).json({ error: 'order_not_in_progress', status: o.status }) }
    await c.query('UPDATE orders SET status=$2, last_error=$3, lease_expires_at=NULL, updated_at=now() WHERE id=$1', [o.id, status, req.body?.error || null]);
    await c.query("INSERT INTO order_events(order_id, event_type, payload) VALUES($1, $2, $3)", [o.id, status.toLowerCase(), req.body || {}]);
    await c.query("UPDATE oxide_bot_agents SET work_state='standby', updated_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM orders WHERE bot_id=$1 AND status='IN_PROGRESS' AND id<>$2)", [o.bot_id, o.id]);
    await c.query('COMMIT');
    broadcast('order.updated', { orderId: o.id, status });
    res.json((await pool.query('SELECT * FROM orders WHERE id=$1', [o.id])).rows[0]);
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}));

app.get('/api/v1/bots/:id/logs', asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const r = await pool.query('SELECT * FROM bot_logs WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 200', [id]);
  res.json(r.rows);
}));

app.post('/api/v1/bots/:id/logs', asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  await pool.query('INSERT INTO bot_logs(bot_id, level, message, metadata) VALUES($1, $2, $3, $4)', [id, req.body?.level || 'info', req.body?.message || '', req.body?.metadata || null]);
  res.status(201).json({ ok: true });
}));

app.post('/api/v1/deployments/packages', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const version = String(req.body?.version || '').trim();
  if (!version) return res.status(400).json({ error: 'version_required' });
  if (!req.file.originalname.toLowerCase().endsWith('.zip')) return res.status(400).json({ error: 'zip_required' });
  const hash = createHash('sha256').update(req.file.buffer).digest('hex');
  const dir = process.env.PACKAGE_DIR || '/data/packages';
  await mkdir(dir, { recursive: true });
  const file = `${version.replace(/[^a-zA-Z0-9._-]/g, '_')}-${hash.slice(0, 12)}.zip`;
  const storage = path.join(dir, file);
  await writeFile(storage, req.file.buffer, { flag: 'wx' }).catch(async e => { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e });
  const r = await pool.query('INSERT INTO code_packages(version, file_name, sha256, storage_path, uploaded_by) VALUES($1, $2, $3, $4, $5) RETURNING *', [version, req.file.originalname, hash, storage, actor(req)]);
  await audit(actor(req), 'package.upload', 'package', String(r.rows[0].id), { version, sha256: hash });
  res.status(201).json(r.rows[0]);
}));

app.get('/api/v1/deployments/packages', asyncRoute(async (_req, res) => {
  res.json((await pool.query('SELECT id, version, file_name, sha256, uploaded_by, created_at FROM code_packages ORDER BY created_at DESC')).rows);
}));

app.post('/api/v1/deployments', asyncRoute(async (req, res) => {
  const packageId = Number(req.body?.packageId), botId = req.body?.botId || null;
  const pkg = await pool.query('SELECT * FROM code_packages WHERE id=$1', [packageId]);
  if (!pkg.rowCount) return res.status(404).json({ error: 'package_not_found' });
  if (botId && !await getBot(botId)) return res.status(404).json({ error: 'bot_not_found' });
  const bots = botId ? [{ id: botId }] : (await pool.query("SELECT id FROM oxide_bot_agents WHERE enabled")).rows;
  const rows = [];
  for (const b of bots) {
    const ins = await pool.query("INSERT INTO deployments(package_id, bot_id, requested_by, status) VALUES($1, $2, $3, 'running') RETURNING *", [packageId, b.id, actor(req)]);
    try {
      const result = await simulatorCommand(b.id, 'restart');
      await pool.query("UPDATE deployments SET status='success', result=$2, completed_at=now() WHERE id=$1", [ins.rows[0].id, { simulator: result, version: pkg.rows[0].version }]);
      await pool.query('UPDATE oxide_bot_agents SET current_version=$2 WHERE id=$1', [b.id, pkg.rows[0].version]);
      rows.push({ ...ins.rows[0], status: 'success' });
    } catch (e) {
      await pool.query("UPDATE deployments SET status='failed', result=$2, completed_at=now() WHERE id=$1", [ins.rows[0].id, { error: String(e) }]);
      rows.push({ ...ins.rows[0], status: 'failed' });
    }
  }
  await audit(actor(req), 'deployment.create', 'package', String(packageId), { botId, count: rows.length });
  res.status(202).json(rows);
}));

app.get('/api/v1/deployments', asyncRoute(async (_req, res) => {
  res.json((await pool.query('SELECT d.*, p.version, p.file_name, b.name bot_name FROM deployments d JOIN code_packages p ON p.id=d.package_id LEFT JOIN oxide_bot_agents b ON b.id=d.bot_id ORDER BY d.created_at DESC LIMIT 200')).rows);
}));

app.get('/api/v1/audit', asyncRoute(async (_req, res) => {
  res.json((await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200')).rows);
}));

app.use(express.static(path.resolve('dashboard')));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: process.env.NODE_ENV === 'production' ? 'Request failed' : String(err) });
});

async function maintenance() {
  const stale = await pool.query("UPDATE oxide_bot_agents SET status='offline', work_state='standby', cpu_percent=0, memory_percent=0, updated_at=now() WHERE status='online' AND last_heartbeat < now()-($1::int*interval '1 millisecond') RETURNING id", [heartbeatTimeoutMs]);
  for (const b of stale.rows) {
    await pool.query("INSERT INTO bot_logs(bot_id, level, message) VALUES($1, 'warn', 'Heartbeat timeout; marked offline')", [b.id]);
    await pool.query("INSERT INTO order_events(order_id, event_type, payload) SELECT id, 'bot_timeout', jsonb_build_object('botId', $1) FROM orders WHERE bot_id=$1 AND status='IN_PROGRESS'", [b.id]);
    await pool.query("UPDATE orders SET status=CASE WHEN attempts>=max_attempts THEN 'FAILED' ELSE 'DELAYED' END, last_error='bot heartbeat timeout', lease_expires_at=NULL, updated_at=now() WHERE bot_id=$1 AND status='IN_PROGRESS'", [b.id]);
    await pool.query("UPDATE orders SET status='QUEUED', bot_id=NULL, updated_at=now() WHERE bot_id=$1 AND status='DELAYED'", [b.id]);
    broadcast('bot.offline', { botId: b.id });
  }
  const expired = await pool.query("WITH exp AS (SELECT id, bot_id FROM orders WHERE status='IN_PROGRESS' AND lease_expires_at < now() FOR UPDATE SKIP LOCKED), upd AS (UPDATE orders o SET status=CASE WHEN o.attempts>=o.max_attempts THEN 'FAILED' ELSE 'QUEUED' END, bot_id=NULL, lease_expires_at=NULL, last_error='order lease expired', updated_at=now() FROM exp WHERE o.id=exp.id RETURNING o.id, o.status, exp.bot_id) SELECT * FROM upd");
  for (const o of expired.rows) {
    await pool.query("INSERT INTO order_events(order_id, event_type, payload) VALUES($1, 'lease_expired', $2)", [o.id, { status: o.status, botId: o.bot_id }]);
    if (o.bot_id) await pool.query("UPDATE oxide_bot_agents SET work_state='standby', updated_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM orders WHERE bot_id=$1 AND status='IN_PROGRESS')", [o.bot_id]);
    broadcast('order.lease_expired', o);
  }
}

server.listen(Number(port), '0.0.0.0', async () => {
  console.log(`Central monitor listening on :${port}`);
  await refreshBots();
  setInterval(() => void refreshBots(), Number(process.env.BOT_POLL_MS || 5000));
  setInterval(() => void maintenance().catch(console.error), 5000);
});

process.on('SIGTERM', () => {
  server.close(() => void pool.end());
});