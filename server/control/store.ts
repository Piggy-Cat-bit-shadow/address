import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../database/sqlite.mjs';
import { decryptSecret, encryptSecret, hashPassword, opaqueToken, safeEqual, tokenHash, verifyPassword } from './security';

export type SessionRole = 'admin' | 'frontend';
export type ProviderName = 'amap' | 'baidu' | 'tencent';
export type CredentialOutcome = 'success' | 'qps' | 'quota' | 'auth' | 'network' | 'invalid';

interface IdentityRow { password_hash: string; password_salt: string }
interface SessionRow { role: SessionRole; csrf_hash: string; expires_at: string }
interface ApiTokenRow { id: string; name: string; scopes_json: string; rate_limit_per_minute: number; expires_at: string | null; revoked_at: string | null }
interface CredentialRow {
  id: string; provider: ProviderName; label: string; secret_ciphertext: string; secret_iv: string; secret_tag: string;
  enabled: number; status: string; weight: number; qps_limit: number; daily_limit: number; quota_scope_id: string;
  cooldown_until: string | null; failure_count: number; last_used_at: string | null; last_success_at: string | null;
  last_failure_at: string | null; created_at: string; updated_at: string; used_today?: number;
}
export type ApiAuthorization = { status: 'authorized'; id: string; name: string } | { status: 'unauthorized' | 'rate_limited' };

const nowIso = (): string => new Date().toISOString();
const json = <T>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const publicCredential = (row: CredentialRow) => ({
  id: row.id,
  provider: row.provider,
  label: row.label,
  mask: `••••${row.id.slice(-4)}`,
  enabled: Boolean(row.enabled),
  status: row.status,
  weight: row.weight,
  qpsLimit: row.qps_limit,
  dailyLimit: row.daily_limit,
  quotaScopeId: row.quota_scope_id,
  usedToday: Number(row.used_today || 0),
  cooldownUntil: row.cooldown_until,
  failureCount: row.failure_count,
  lastUsedAt: row.last_used_at,
  lastSuccessAt: row.last_success_at,
  lastFailureAt: row.last_failure_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export class ControlStore {
  constructor(private readonly database: SqliteDatabase, private readonly masterKey: Buffer) {}

  async initialize(bootstrapPassword?: string): Promise<void> {
    await this.database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(nowIso()).run();
    const admin = await this.database.prepare("SELECT id FROM auth_identities WHERE kind='admin'").first<{ id: string }>();
    if (!admin && bootstrapPassword) await this.setPassword('admin', bootstrapPassword);
    await this.setDefault('frontend_password_enabled', false);
    await this.setDefault('api_auth_enabled', true);
  }

  async status(): Promise<{ initialized: boolean; frontendPasswordEnabled: boolean; apiAuthEnabled: boolean }> {
    const admin = await this.database.prepare("SELECT id FROM auth_identities WHERE kind='admin'").first<{ id: string }>();
    return {
      initialized: Boolean(admin),
      frontendPasswordEnabled: await this.setting('frontend_password_enabled', false),
      apiAuthEnabled: await this.setting('api_auth_enabled', true)
    };
  }

  async setting<T>(key: string, fallback: T): Promise<T> {
    const row = await this.database.prepare('SELECT value_json FROM system_settings WHERE key=?').bind(key).first<{ value_json: string }>();
    return json(row?.value_json, fallback);
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.database.prepare(`INSERT INTO system_settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(key, JSON.stringify(value), nowIso()).run();
  }

  private async setDefault(key: string, value: unknown): Promise<void> {
    await this.database.prepare('INSERT OR IGNORE INTO system_settings(key,value_json,updated_at) VALUES (?,?,?)')
      .bind(key, JSON.stringify(value), nowIso()).run();
  }

  async setPassword(kind: SessionRole, password: string): Promise<void> {
    const value = await hashPassword(password);
    const now = nowIso();
    await this.database.prepare(`INSERT INTO auth_identities(id,kind,password_hash,password_salt,created_at,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET password_hash=excluded.password_hash,
      password_salt=excluded.password_salt,updated_at=excluded.updated_at`)
      .bind(randomUUID(), kind, value.hash, value.salt, now, now).run();
    await this.database.prepare('DELETE FROM auth_sessions WHERE role=?').bind(kind).run();
  }

  async verifyIdentity(kind: SessionRole, password: string): Promise<boolean> {
    const row = await this.database.prepare('SELECT password_hash,password_salt FROM auth_identities WHERE kind=?')
      .bind(kind).first<IdentityRow>();
    return Boolean(row && await verifyPassword(password, row.password_hash, row.password_salt));
  }

  async hasIdentity(kind: SessionRole): Promise<boolean> {
    return Boolean(await this.database.prepare('SELECT id FROM auth_identities WHERE kind=?').bind(kind).first<{ id: string }>());
  }

  async createSession(role: SessionRole, ip = ''): Promise<{ token: string; csrf: string; expiresAt: string }> {
    const token = opaqueToken();
    const csrf = opaqueToken(24);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + (role === 'admin' ? 12 : 24) * 60 * 60 * 1000).toISOString();
    await this.database.prepare(`INSERT INTO auth_sessions(id_hash,role,csrf_hash,created_at,expires_at,last_seen_at,ip_hash)
      VALUES (?,?,?,?,?,?,?)`).bind(tokenHash(token), role, tokenHash(csrf), createdAt.toISOString(), expiresAt, createdAt.toISOString(), ip ? tokenHash(ip) : '').run();
    return { token, csrf, expiresAt };
  }

  async session(token: string, role: SessionRole, csrf?: string): Promise<boolean> {
    if (!token) return false;
    const row = await this.database.prepare('SELECT role,csrf_hash,expires_at FROM auth_sessions WHERE id_hash=?')
      .bind(tokenHash(token)).first<SessionRow>();
    if (!row || row.role !== role || new Date(row.expires_at).getTime() <= Date.now()) return false;
    if (csrf !== undefined && !safeEqual(tokenHash(csrf), row.csrf_hash)) return false;
    await this.database.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE id_hash=?').bind(nowIso(), tokenHash(token)).run();
    return true;
  }

  async deleteSession(token: string): Promise<void> {
    if (token) await this.database.prepare('DELETE FROM auth_sessions WHERE id_hash=?').bind(tokenHash(token)).run();
  }

  async createApiToken(input: { name: string; scopes: string[]; rateLimit: number; expiresAt?: string | null }): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const secret = `addr_${opaqueToken()}`;
    const createdAt = nowIso();
    await this.database.prepare(`INSERT INTO api_tokens(id,name,token_prefix,token_hash,scopes_json,rate_limit_per_minute,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      id, input.name.trim().slice(0, 80), secret.slice(0, 12), tokenHash(secret), JSON.stringify([...new Set(input.scopes)]),
      Math.max(1, Math.min(100000, Math.trunc(input.rateLimit))), input.expiresAt || null, createdAt
    ).run();
    return { id, token: secret };
  }

  async listApiTokens(): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.database.prepare(`SELECT id,name,token_prefix,scopes_json,rate_limit_per_minute,expires_at,last_used_at,revoked_at,created_at
      FROM api_tokens ORDER BY created_at DESC`).all<Record<string, unknown>>()).results;
    return rows.map((row) => ({ ...row, scopes: json(String(row.scopes_json || ''), []), scopes_json: undefined }));
  }

  async authorizeApiToken(secret: string, scope = 'generate'): Promise<{ id: string; name: string } | null> {
    const result = await this.authorizeApiTokenDetailed(secret, scope);
    return result.status === 'authorized' ? { id: result.id, name: result.name } : null;
  }

  async authorizeApiTokenDetailed(secret: string, scope = 'generate'): Promise<ApiAuthorization> {
    if (!await this.setting('api_auth_enabled', true)) return { status: 'authorized', id: 'disabled', name: 'authentication-disabled' };
    if (!secret) return { status: 'unauthorized' };
    const row = await this.database.prepare(`SELECT id,name,scopes_json,rate_limit_per_minute,expires_at,revoked_at
      FROM api_tokens WHERE token_hash=?`).bind(tokenHash(secret)).first<ApiTokenRow>();
    if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) return { status: 'unauthorized' };
    const scopes = json<string[]>(row.scopes_json, []);
    if (!scopes.includes('*') && !scopes.includes(scope)) return { status: 'unauthorized' };
    if (!await this.consumeRateLimit(`api:${row.id}`, row.rate_limit_per_minute)) return { status: 'rate_limited' };
    await this.database.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').bind(nowIso(), row.id).run();
    return { status: 'authorized', id: row.id, name: row.name };
  }

  async revokeApiToken(id: string): Promise<void> {
    await this.database.prepare('UPDATE api_tokens SET revoked_at=? WHERE id=?').bind(nowIso(), id).run();
  }

  private async consumeRateLimit(key: string, limit: number): Promise<boolean> {
    const start = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const row = await this.database.prepare('SELECT window_started_at,request_count FROM rate_limit_buckets WHERE bucket_key=?')
      .bind(key).first<{ window_started_at: string; request_count: number }>();
    const count = row?.window_started_at === start ? row.request_count : 0;
    if (count >= limit) return false;
    await this.database.prepare(`INSERT INTO rate_limit_buckets(bucket_key,window_started_at,request_count) VALUES (?,?,1)
      ON CONFLICT(bucket_key) DO UPDATE SET window_started_at=excluded.window_started_at,
      request_count=CASE WHEN rate_limit_buckets.window_started_at=excluded.window_started_at THEN rate_limit_buckets.request_count+1 ELSE 1 END`)
      .bind(key, start).run();
    return true;
  }

  async addCredential(input: { provider: ProviderName; label: string; secret: string; weight?: number; qpsLimit?: number; dailyLimit?: number; quotaScopeId?: string }): Promise<string> {
    if (!['amap', 'baidu', 'tencent'].includes(input.provider) || !input.secret?.trim() || !input.label?.trim()) throw new Error('INVALID_PROVIDER_CREDENTIAL');
    const id = randomUUID();
    const encrypted = encryptSecret(input.secret.trim(), this.masterKey);
    const now = nowIso();
    const weight = boundedInteger(input.weight, 100, 1, 10000, 'INVALID_CREDENTIAL_WEIGHT');
    const qpsLimit = boundedInteger(input.qpsLimit, 1, 1, 10000, 'INVALID_CREDENTIAL_QPS');
    const dailyLimit = boundedInteger(input.dailyLimit, 1000, 1, 100000000, 'INVALID_CREDENTIAL_DAILY_LIMIT');
    await this.database.prepare(`INSERT INTO provider_credentials(
      id,provider,label,secret_ciphertext,secret_iv,secret_tag,weight,qps_limit,daily_limit,quota_scope_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, input.provider, input.label.trim().slice(0, 80), encrypted.ciphertext, encrypted.iv, encrypted.tag,
      weight, qpsLimit, dailyLimit, input.quotaScopeId?.trim().slice(0, 120) || id, now, now
    ).run();
    return id;
  }

  async listCredentials(): Promise<Array<ReturnType<typeof publicCredential>>> {
    const date = new Date().toISOString().slice(0, 10);
    const rows = (await this.database.prepare(`SELECT credential.*,COALESCE(usage.accepted_count+usage.rejected_count,0) AS used_today
      FROM provider_credentials credential LEFT JOIN provider_usage_daily usage
      ON usage.credential_id=credential.id AND usage.usage_date=? ORDER BY provider,label`).bind(date).all<CredentialRow>()).results;
    return rows.map(publicCredential);
  }

  async updateCredential(id: string, input: Record<string, unknown>): Promise<void> {
    const current = await this.database.prepare('SELECT * FROM provider_credentials WHERE id=?').bind(id).first<CredentialRow>();
    if (!current) throw new Error('CREDENTIAL_NOT_FOUND');
    const label = String(input.label ?? current.label).trim().slice(0, 80);
    const quotaScopeId = String(input.quotaScopeId ?? current.quota_scope_id).trim().slice(0, 120);
    if (!label || !quotaScopeId) throw new Error('INVALID_PROVIDER_CREDENTIAL');
    const weight = boundedInteger(input.weight, current.weight, 1, 10000, 'INVALID_CREDENTIAL_WEIGHT');
    const qpsLimit = boundedInteger(input.qpsLimit, current.qps_limit, 1, 10000, 'INVALID_CREDENTIAL_QPS');
    const dailyLimit = boundedInteger(input.dailyLimit, current.daily_limit, 1, 100000000, 'INVALID_CREDENTIAL_DAILY_LIMIT');
    await this.database.prepare(`UPDATE provider_credentials SET label=?,enabled=?,weight=?,qps_limit=?,daily_limit=?,quota_scope_id=?,
      status=CASE WHEN ?=0 THEN 'disabled' WHEN status='disabled' THEN 'healthy' ELSE status END,updated_at=? WHERE id=?`).bind(
      label, input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0, weight, qpsLimit, dailyLimit,
      quotaScopeId, input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0, nowIso(), id
    ).run();
  }

  async deleteCredential(id: string): Promise<void> {
    await this.database.prepare('DELETE FROM provider_credentials WHERE id=?').bind(id).run();
  }

  async acquireCredential(provider: ProviderName): Promise<{ id: string; provider: ProviderName; secret: string } | null> {
    const date = new Date().toISOString().slice(0, 10);
    const now = nowIso();
    const row = await this.database.prepare(`SELECT credential.*,
      COALESCE((SELECT SUM(scope_usage.accepted_count+scope_usage.rejected_count)
        FROM provider_credentials scope_credential JOIN provider_usage_daily scope_usage ON scope_usage.credential_id=scope_credential.id
        WHERE scope_credential.quota_scope_id=credential.quota_scope_id AND scope_usage.usage_date=?),0) AS used_today
      FROM provider_credentials credential
      WHERE credential.provider=? AND credential.enabled=1 AND credential.status NOT IN ('disabled','needs_review','quota_exhausted')
      AND (credential.cooldown_until IS NULL OR credential.cooldown_until<=?)
      AND (credential.last_used_at IS NULL OR (julianday(?) - julianday(credential.last_used_at))*86400 >= 1.0/credential.qps_limit)
      AND COALESCE((SELECT SUM(scope_usage.accepted_count+scope_usage.rejected_count)
        FROM provider_credentials scope_credential JOIN provider_usage_daily scope_usage ON scope_usage.credential_id=scope_credential.id
        WHERE scope_credential.quota_scope_id=credential.quota_scope_id AND scope_usage.usage_date=?),0)<credential.daily_limit
      ORDER BY (1.0-CAST(COALESCE((SELECT SUM(scope_usage.accepted_count+scope_usage.rejected_count)
        FROM provider_credentials scope_credential JOIN provider_usage_daily scope_usage ON scope_usage.credential_id=scope_credential.id
        WHERE scope_credential.quota_scope_id=credential.quota_scope_id AND scope_usage.usage_date=?),0) AS REAL)/credential.daily_limit)*credential.weight DESC,
      credential.last_used_at IS NOT NULL,credential.last_used_at LIMIT 1`).bind(date, provider, now, now, date, date).first<CredentialRow>();
    if (!row) return null;
    await this.database.prepare('UPDATE provider_credentials SET last_used_at=?,status=? WHERE id=?')
      .bind(now, 'healthy', row.id).run();
    return {
      id: row.id,
      provider: row.provider,
      secret: decryptSecret({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag }, this.masterKey)
    };
  }

  async reportCredential(id: string, outcome: CredentialOutcome): Promise<void> {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    await this.database.prepare(`INSERT INTO provider_usage_daily(credential_id,usage_date,accepted_count,rejected_count)
      VALUES (?,?,?,?) ON CONFLICT(credential_id,usage_date) DO UPDATE SET
      accepted_count=accepted_count+excluded.accepted_count,rejected_count=rejected_count+excluded.rejected_count`)
      .bind(id, date, outcome === 'success' ? 1 : 0, outcome === 'success' ? 0 : 1).run();
    if (outcome === 'success') {
      await this.database.prepare(`UPDATE provider_credentials SET status='healthy',failure_count=0,cooldown_until=NULL,
        last_success_at=?,updated_at=? WHERE id=?`).bind(now.toISOString(), now.toISOString(), id).run();
      return;
    }
    const row = await this.database.prepare('SELECT failure_count FROM provider_credentials WHERE id=?').bind(id).first<{ failure_count: number }>();
    const failures = Number(row?.failure_count || 0) + 1;
    const tomorrow = new Date(now); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); tomorrow.setUTCHours(0, 0, 0, 0);
    const cooldown = outcome === 'quota' ? tomorrow
      : new Date(now.getTime() + Math.min(300000, 1000 * 2 ** Math.min(failures, 8)));
    const status = outcome === 'auth' || outcome === 'invalid' ? 'needs_review' : outcome === 'quota' ? 'quota_exhausted' : 'cooldown';
    await this.database.prepare(`UPDATE provider_credentials SET status=?,failure_count=?,cooldown_until=?,last_failure_at=?,updated_at=? WHERE id=?`)
      .bind(status, failures, cooldown.toISOString(), now.toISOString(), now.toISOString(), id).run();
  }

  async audit(actor: string, action: string, target: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.database.prepare('INSERT INTO audit_events(actor,action,target,details_json,created_at) VALUES (?,?,?,?,?)')
      .bind(actor, action, target, JSON.stringify(details), nowIso()).run();
  }

  async audits(limit = 100): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.database.prepare('SELECT id,actor,action,target,details_json,created_at FROM audit_events ORDER BY id DESC LIMIT ?')
      .bind(Math.max(1, Math.min(500, limit))).all<Record<string, unknown>>()).results;
    return rows.map((row) => ({ ...row, details: json(String(row.details_json || ''), {}), details_json: undefined }));
  }

  async createRun(kind: string, target: Record<string, unknown>): Promise<string> {
    const id = `sync-${Date.now()}-${randomUUID()}`;
    const now = nowIso();
    await this.database.prepare(`INSERT INTO sync_runs(id,kind,target_json,status,progress_json,created_at,updated_at)
      VALUES (?,?,?,'queued','{}',?,?)`).bind(id, kind, JSON.stringify(target), now, now).run();
    return id;
  }

  async updateRun(id: string, status: string, progress: Record<string, unknown>, error?: { code: string; message: string }): Promise<void> {
    const now = nowIso();
    await this.database.prepare(`UPDATE sync_runs SET status=?,progress_json=?,error_code=?,error_message=?,
      started_at=COALESCE(started_at,?),completed_at=CASE WHEN ? IN ('succeeded','failed','cancelled') THEN ? ELSE completed_at END,updated_at=? WHERE id=?`)
      .bind(status, JSON.stringify(progress), error?.code || null, error?.message?.slice(0, 1000) || null, now, status, now, now, id).run();
  }

  async runs(limit = 50): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.database.prepare('SELECT * FROM sync_runs ORDER BY created_at DESC LIMIT ?').bind(limit).all<Record<string, unknown>>()).results;
    return rows.map((row) => ({ ...row, target: json(String(row.target_json || ''), {}), progress: json(String(row.progress_json || ''), {}), target_json: undefined, progress_json: undefined }));
  }
}

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number, error: string): number => {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(error);
  return number;
};
