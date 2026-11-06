CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO system_settings(key,value) VALUES ('kill_switch','{"enabled":false}') ON CONFLICT(key) DO NOTHING;
CREATE TABLE IF NOT EXISTS oxide_bot_agents (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, device_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline','starting','stopping','error')),
 work_state TEXT NOT NULL DEFAULT 'standby' CHECK(work_state IN ('standby','in_progress')),
 enabled BOOLEAN NOT NULL DEFAULT true, cpu_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
 memory_percent NUMERIC(5,2) NOT NULL DEFAULT 0, uptime_seconds BIGINT NOT NULL DEFAULT 0,
 current_version TEXT, last_heartbeat TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bot_metrics (id BIGSERIAL PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES oxide_bot_agents(id) ON DELETE CASCADE, cpu_percent NUMERIC(5,2) NOT NULL DEFAULT 0, memory_percent NUMERIC(5,2) NOT NULL DEFAULT 0, uptime_seconds BIGINT NOT NULL DEFAULT 0, captured_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bot_logs (id BIGSERIAL PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES oxide_bot_agents(id) ON DELETE CASCADE, level TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL, metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS oxide_bot_commands (id BIGSERIAL PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES oxide_bot_agents(id), command TEXT NOT NULL CHECK(command IN ('start','stop','restart','status','update')), requested_by TEXT NOT NULL, idempotency_key TEXT, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','success','failed')), result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ, UNIQUE(bot_id,idempotency_key));
CREATE TABLE IF NOT EXISTS code_packages (id BIGSERIAL PRIMARY KEY, version TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, sha256 TEXT NOT NULL, storage_path TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS deployments (id BIGSERIAL PRIMARY KEY, package_id BIGINT NOT NULL REFERENCES code_packages(id), bot_id TEXT REFERENCES oxide_bot_agents(id), status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','success','failed')), requested_by TEXT NOT NULL, result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS orders (id BIGSERIAL PRIMARY KEY, external_order_id TEXT UNIQUE NOT NULL, idempotency_key TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK(status IN ('PENDING_PAYMENT','QUEUED','IN_PROGRESS','DELAYED','COMPLETED','FAILED','EXPIRED')), amount NUMERIC(12,2) NOT NULL DEFAULT 0, currency CHAR(3) NOT NULL DEFAULT 'THB', payload JSONB NOT NULL DEFAULT '{}', bot_id TEXT REFERENCES oxide_bot_agents(id), attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5, lease_expires_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS order_events (id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, event_type TEXT NOT NULL, payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs (id BIGSERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_commands_bot_created ON oxide_bot_commands(bot_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_heartbeat ON oxide_bot_agents(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_metrics_bot_captured ON bot_metrics(bot_id,captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_bot_created ON bot_logs(bot_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status,created_at);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_created ON deployments(created_at DESC);
