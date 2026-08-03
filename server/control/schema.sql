CREATE TABLE IF NOT EXISTS control_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (value_json IS JSON),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL UNIQUE CHECK (kind IN ('admin','frontend')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','frontend')),
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip_hash TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT,
  token_iv TEXT,
  token_tag TEXT,
  scopes_json TEXT NOT NULL CHECK (scopes_json IS JSON),
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 100000),
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('amap','baidu','tencent','onemap','youdao','geoapify','google-geocoding')),
  label TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_tag TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','cooldown','quota_exhausted','needs_review','disabled')),
  weight INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 10000),
  qps_limit INTEGER NOT NULL DEFAULT 1 CHECK (qps_limit BETWEEN 1 AND 10000),
  daily_limit INTEGER NOT NULL DEFAULT 1000 CHECK (daily_limit BETWEEN 1 AND 100000000),
  quota_service TEXT NOT NULL DEFAULT 'place-search',
  quota_period TEXT NOT NULL DEFAULT 'day' CHECK (quota_period IN ('day','month')),
  quota_limit INTEGER NOT NULL DEFAULT 1000 CHECK (quota_limit BETWEEN 1 AND 100000000),
  quota_timezone_offset INTEGER NOT NULL DEFAULT 480 CHECK (quota_timezone_offset BETWEEN -720 AND 840),
  quota_scope_id TEXT NOT NULL,
  provider_reported_used INTEGER,
  provider_reported_limit INTEGER,
  provider_reported_reset_at TEXT,
  provider_reported_at TEXT,
  cooldown_until TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_used_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_usage_daily (
  credential_id TEXT NOT NULL REFERENCES provider_credentials(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (credential_id, usage_date)
);

CREATE TABLE IF NOT EXISTS provider_usage_periods (
  credential_id TEXT NOT NULL REFERENCES provider_credentials(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (credential_id, period_start)
);

CREATE TABLE IF NOT EXISTS browser_map_credentials (
  provider TEXT PRIMARY KEY CHECK (provider = 'amap'),
  label TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  api_key_iv TEXT NOT NULL,
  api_key_tag TEXT NOT NULL,
  security_code_ciphertext TEXT NOT NULL,
  security_code_iv TEXT NOT NULL,
  security_code_tag TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (target_json IS JSON),
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused_quota','needs_review','succeeded','failed','cancelled')),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK (progress_json IS JSON),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (details_json IS JSON),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_pick ON provider_credentials(provider,enabled,status,cooldown_until,last_used_at);
CREATE INDEX IF NOT EXISTS idx_sync_runs_created ON sync_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);

INSERT INTO control_migrations(version,applied_at)
SELECT version, CURRENT_TIMESTAMP::text FROM generate_series(1, 8) AS version
ON CONFLICT (version) DO NOTHING;
