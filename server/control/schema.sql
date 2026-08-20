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
  provider TEXT NOT NULL CHECK (provider IN ('amap','baidu','tencent','onemap','youdao','geoapify','google-geocoding','mappls')),
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

CREATE TABLE IF NOT EXISTS provider_quota_windows (
  id BIGSERIAL PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES provider_credentials(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('day','month')),
  limit_count INTEGER NOT NULL CHECK (limit_count BETWEEN 1 AND 100000000),
  timezone_offset INTEGER NOT NULL DEFAULT 480 CHECK (timezone_offset BETWEEN -720 AND 840),
  source TEXT NOT NULL DEFAULT 'default' CHECK (source IN ('default','admin','provider')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (credential_id, service, period)
);

CREATE TABLE IF NOT EXISTS provider_quota_observations (
  credential_id TEXT NOT NULL REFERENCES provider_credentials(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('day','month')),
  used_count INTEGER NOT NULL CHECK (used_count >= 0),
  limit_count INTEGER NOT NULL CHECK (limit_count > 0),
  reset_at TEXT,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'provider' CHECK (source IN ('provider','local')),
  PRIMARY KEY (credential_id, service, period)
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
  failure_phase TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_run_countries (
  run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL CHECK (length(country_code) = 2 AND country_code = upper(country_code)),
  source_id TEXT NOT NULL DEFAULT '',
  trigger_name TEXT NOT NULL DEFAULT 'scheduled',
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused_quota','needs_review','succeeded','failed','cancelled')),
  started_at TEXT,
  completed_at TEXT,
  heartbeat_at TEXT,
  deadline_at TEXT,
  before_count INTEGER,
  after_count INTEGER,
  net_growth INTEGER,
  candidate_count INTEGER,
  accepted_count INTEGER,
  rejected_count INTEGER,
  rejection_reasons_json TEXT NOT NULL DEFAULT '{}' CHECK (rejection_reasons_json IS JSON),
  metrics_json TEXT NOT NULL DEFAULT '{}' CHECK (metrics_json IS JSON),
  before_goals_json TEXT NOT NULL DEFAULT '{}' CHECK (before_goals_json IS JSON),
  after_goals_json TEXT NOT NULL DEFAULT '{}' CHECK (after_goals_json IS JSON),
  error_code TEXT,
  error_message TEXT,
  failure_phase TEXT,
  source_complete INTEGER NOT NULL DEFAULT 1 CHECK (source_complete IN (0, 1)),
  source_fingerprint TEXT,
  source_version_before TEXT,
  source_version_after TEXT,
  adapter_revision TEXT,
  checkpoint_token TEXT,
  source_state_applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, country_code, source_id)
);

ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS source_fingerprint TEXT;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS source_version_before TEXT;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS source_version_after TEXT;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS adapter_revision TEXT;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS checkpoint_token TEXT;

CREATE TABLE IF NOT EXISTS sync_scheduler_state (
  scheduler_id TEXT PRIMARY KEY,
  leader_token TEXT,
  heartbeat_at TEXT,
  last_planned_at TEXT,
  active_run_id TEXT REFERENCES sync_runs(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS credential_broker_requests (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL CHECK (client_id IN ('production','test')),
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('amap','baidu','tencent','onemap','geoapify','google-geocoding','mappls')),
  operation TEXT NOT NULL,
  parameters_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','unknown')),
  response_status INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (client_id, request_id)
);

CREATE TABLE IF NOT EXISTS credential_broker_dispatches (
  id BIGSERIAL PRIMARY KEY,
  request_key BIGINT NOT NULL REFERENCES credential_broker_requests(id) ON DELETE CASCADE,
  credential_id TEXT REFERENCES provider_credentials(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatched','success','rejected','unknown')),
  outcome TEXT,
  reserved_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS credential_broker_quota_counters (
  scope_id TEXT NOT NULL,
  service TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('day','month')),
  period_start TEXT NOT NULL,
  limit_count INTEGER NOT NULL CHECK (limit_count > 0),
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
  production_count INTEGER NOT NULL DEFAULT 0 CHECK (production_count >= 0),
  test_count INTEGER NOT NULL DEFAULT 0 CHECK (test_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, service, period, period_start)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_pick ON provider_credentials(provider,enabled,status,cooldown_until,last_used_at);
CREATE INDEX IF NOT EXISTS idx_provider_quota_windows_credential ON provider_quota_windows(credential_id,enabled,period);
CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_reset ON provider_quota_observations(reset_at);
CREATE INDEX IF NOT EXISTS idx_sync_runs_created ON sync_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_run_countries_history ON sync_run_countries(country_code,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_run_countries_status ON sync_run_countries(status,heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credential_broker_requests_status
  ON credential_broker_requests(status,updated_at);
CREATE INDEX IF NOT EXISTS idx_credential_broker_dispatches_request
  ON credential_broker_dispatches(request_key,reserved_at);

ALTER TABLE provider_credentials DROP CONSTRAINT IF EXISTS provider_credentials_provider_check;
ALTER TABLE provider_credentials ADD CONSTRAINT provider_credentials_provider_check
  CHECK (provider IN ('amap','baidu','tencent','onemap','youdao','geoapify','google-geocoding','mappls'));

ALTER TABLE credential_broker_requests DROP CONSTRAINT IF EXISTS credential_broker_requests_provider_check;
ALTER TABLE credential_broker_requests ADD CONSTRAINT credential_broker_requests_provider_check
  CHECK (provider IN ('amap','baidu','tencent','onemap','geoapify','google-geocoding','mappls'));

ALTER TABLE credential_broker_dispatches
  DROP CONSTRAINT IF EXISTS credential_broker_dispatches_credential_id_fkey;
ALTER TABLE credential_broker_dispatches ALTER COLUMN credential_id DROP NOT NULL;
ALTER TABLE credential_broker_dispatches
  ADD CONSTRAINT credential_broker_dispatches_credential_id_fkey
  FOREIGN KEY (credential_id) REFERENCES provider_credentials(id) ON DELETE SET NULL;

ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS candidate_count INTEGER;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS accepted_count INTEGER;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS rejected_count INTEGER;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS rejection_reasons_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS metrics_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS failure_phase TEXT;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS failure_phase TEXT;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS source_complete INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sync_run_countries ADD COLUMN IF NOT EXISTS source_state_applied_at TEXT;

UPDATE sync_run_countries SET source_state_applied_at=COALESCE(completed_at,updated_at)
WHERE source_state_applied_at IS NULL
  AND status IN ('paused_quota','needs_review','succeeded','failed','cancelled')
  AND NOT EXISTS (SELECT 1 FROM control_migrations WHERE version=13);

INSERT INTO provider_quota_windows(
  credential_id,service,scope_id,period,limit_count,timezone_offset,source,enabled,created_at,updated_at
)
SELECT id,quota_service,quota_scope_id,quota_period,quota_limit,quota_timezone_offset,'default',enabled,created_at,updated_at
FROM provider_credentials
ON CONFLICT (credential_id,service,period) DO NOTHING;

INSERT INTO control_migrations(version,applied_at)
SELECT version, CURRENT_TIMESTAMP::text FROM generate_series(1, 18) AS version
ON CONFLICT (version) DO NOTHING;
