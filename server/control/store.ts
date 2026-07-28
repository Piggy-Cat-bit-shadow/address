import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../database/sqlite.mjs';
import { decryptSecret, encryptSecret, hashPassword, opaqueToken, safeEqual, tokenHash, verifyPassword } from './security';

export type SessionRole = 'admin' | 'frontend';
export type ProviderName = 'amap' | 'baidu' | 'tencent';
export type CredentialProviderName = ProviderName | 'onemap';
export type CredentialOutcome = 'success' | 'qps' | 'quota' | 'auth' | 'network' | 'invalid';
export interface CredentialInput { provider: CredentialProviderName; label: string; secret: string; weight?: number; qpsLimit?: number; dailyLimit?: number; quotaScopeId?: string }
export interface MapDisplayConfig {
  google: { china: boolean; international: boolean };
  amap: { china: boolean; international: boolean };
}
export interface BrowserMapCredentialInput { label?: string; apiKey: string; securityCode: string; enabled?: boolean }
export interface BrowserMapCredentialUpdate { label?: string; apiKey?: string; securityCode?: string; enabled?: boolean }

export const DEFAULT_MAP_DISPLAY_CONFIG: MapDisplayConfig = {
  google: { china: true, international: true },
  amap: { china: false, international: false }
};

const environmentBoolean = (value: string | undefined, fallback: boolean): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

export const mapDisplayConfigFromEnvironment = (environment: Record<string, string | undefined>): MapDisplayConfig => ({
  google: {
    china: environmentBoolean(environment.MAP_GOOGLE_CHINA_ENABLED, DEFAULT_MAP_DISPLAY_CONFIG.google.china),
    international: environmentBoolean(environment.MAP_GOOGLE_INTERNATIONAL_ENABLED, DEFAULT_MAP_DISPLAY_CONFIG.google.international)
  },
  amap: {
    china: environmentBoolean(environment.MAP_AMAP_CHINA_ENABLED, DEFAULT_MAP_DISPLAY_CONFIG.amap.china),
    international: environmentBoolean(environment.MAP_AMAP_INTERNATIONAL_ENABLED, DEFAULT_MAP_DISPLAY_CONFIG.amap.international)
  }
});

export const browserMapCredentialFromEnvironment = (environment: Record<string, string | undefined>): BrowserMapCredentialInput | null => {
  const apiKey = environment.AMAP_JS_API_KEY?.trim();
  const securityCode = environment.AMAP_JS_SECURITY_CODE?.trim();
  return apiKey && securityCode ? { label: 'AMAP_JS_API_KEY', apiKey, securityCode } : null;
};

const environmentCredentialDefinitions = [
  ['AMAP_API_KEY', 'amap'], ['BAIDU_API_KEY', 'baidu'], ['TENCENT_API_KEY', 'tencent'], ['ONEMAP_ACCESS_TOKEN', 'onemap']
] as const;
export const credentialsFromEnvironment = (environment: Record<string, string | undefined>): CredentialInput[] =>
  environmentCredentialDefinitions.flatMap(([baseName, provider]) => {
    const names = [baseName, ...Object.keys(environment)
      .filter((name) => {
        if (!name.startsWith(`${baseName}_`)) return false;
        return /^\d+$/u.test(name.slice(baseName.length + 1));
      })
      .sort((left, right) => Number(left.slice(baseName.length + 1)) - Number(right.slice(baseName.length + 1)))];
    return names.flatMap((name) => {
      const secret = environment[name]?.trim();
      return secret ? [{ provider, label: name, secret }] : [];
    });
  });

interface IdentityRow { password_hash: string; password_salt: string }
interface SessionRow { role: SessionRole; csrf_hash: string; expires_at: string }
interface ApiTokenRow {
  id: string; name: string; token_hash: string; token_ciphertext: string | null; token_iv: string | null; token_tag: string | null;
  scopes_json: string; rate_limit_per_minute: number; expires_at: string | null; revoked_at: string | null;
}
interface CredentialRow {
  id: string; provider: CredentialProviderName; label: string; secret_ciphertext: string; secret_iv: string; secret_tag: string;
  enabled: number; status: string; weight: number; qps_limit: number; daily_limit: number; quota_scope_id: string;
  cooldown_until: string | null; failure_count: number; last_used_at: string | null; last_success_at: string | null;
  last_failure_at: string | null; created_at: string; updated_at: string; used_today?: number;
}
interface BrowserMapCredentialRow {
  provider: 'amap'; label: string;
  api_key_ciphertext: string; api_key_iv: string; api_key_tag: string;
  security_code_ciphertext: string; security_code_iv: string; security_code_tag: string;
  enabled: number; last_used_at: string | null; created_at: string; updated_at: string;
}
export type ApiAuthorization = { status: 'authorized'; id: string; name: string } | { status: 'unauthorized' | 'rate_limited' };
export const API_TOKEN_SCOPES = ['read', 'generate'] as const;

const nowIso = (): string => new Date().toISOString();
const quotaTimezoneOffsetMs = 8 * 60 * 60 * 1000;
const quotaUsageDate = (date = new Date()): string => new Date(date.getTime() + quotaTimezoneOffsetMs).toISOString().slice(0, 10);
const nextQuotaReset = (date: Date): Date => {
  const shifted = new Date(date.getTime() + quotaTimezoneOffsetMs);
  shifted.setUTCHours(24, 0, 0, 0);
  return new Date(shifted.getTime() - quotaTimezoneOffsetMs);
};
export const AMAP_PERSONAL_MONTHLY_LIMIT = 5_000;
export const AMAP_SAFE_DAILY_LIMIT = Math.floor(AMAP_PERSONAL_MONTHLY_LIMIT / 31);
export const credentialProviderDefaults: Record<CredentialProviderName, { qps: number; daily: number }> = {
  amap: { qps: 50, daily: AMAP_SAFE_DAILY_LIMIT },
  baidu: { qps: 3, daily: 100 },
  tencent: { qps: 5, daily: 10_000 },
  onemap: { qps: 1, daily: 100 }
};
const json = <T>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const normalizeTokenScopes = (value: unknown, fallbackAll = true): string[] => {
  if (value === undefined || value === null) return fallbackAll ? ['*'] : [];
  if (!Array.isArray(value)) throw new Error('INVALID_TOKEN_SCOPES');
  const scopes = [...new Set(value.map((scope) => String(scope).trim()).filter(Boolean))];
  if (!scopes.length) return fallbackAll ? ['*'] : [];
  if (scopes.includes('*')) return ['*'];
  if (scopes.some((scope) => !API_TOKEN_SCOPES.includes(scope as typeof API_TOKEN_SCOPES[number]))) throw new Error('INVALID_TOKEN_SCOPES');
  return API_TOKEN_SCOPES.every((scope) => scopes.includes(scope)) ? ['*'] : scopes;
};
const normalizeTokenExpiry = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_TOKEN_EXPIRY');
  return date.toISOString();
};
const validateTokenSecret = (value: string): string => {
  const token = value.trim();
  if (token.length < 16 || token.length > 512 || !/^[\x21-\x7E]+$/u.test(token)) throw new Error('INVALID_TOKEN_VALUE');
  return token;
};
const strictMapDisplayConfig = (value: unknown): MapDisplayConfig => {
  const config = value as Partial<MapDisplayConfig> | null;
  const fields = [config?.google?.china, config?.google?.international, config?.amap?.china, config?.amap?.international];
  if (fields.some((field) => typeof field !== 'boolean')) throw new Error('INVALID_MAP_DISPLAY_CONFIG');
  return {
    google: { china: config!.google!.china!, international: config!.google!.international! },
    amap: { china: config!.amap!.china!, international: config!.amap!.international! }
  };
};
const optionalPassword = (password: unknown, confirmation: unknown): string | undefined => {
  const value = typeof password === 'string' ? password : '';
  const repeat = typeof confirmation === 'string' ? confirmation : '';
  if (!value && !repeat) return undefined;
  if (!value || !repeat || value !== repeat) throw new Error('PASSWORD_CONFIRM_MISMATCH');
  return value;
};
const normalizeMapDisplayConfig = (value: unknown): MapDisplayConfig => {
  try { return strictMapDisplayConfig(value); } catch { return structuredClone(DEFAULT_MAP_DISPLAY_CONFIG); }
};
const jwtExpiresAt = (token: string): string | null => {
  try {
    const parts = token.split('.');
    const payload = parts[1];
    if (parts.length !== 3 || !parts[0] || !payload || !parts[2]) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    const exp = Number(decoded.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return new Date(exp * 1000).toISOString();
  } catch { return null; }
};

interface CredentialInspection { expiresAt: string | null; invalid: boolean; expired: boolean }

const inspectCredential = (row: CredentialRow, masterKey: Buffer): CredentialInspection => {
  if (row.provider !== 'onemap') return { expiresAt: null, invalid: false, expired: false };
  let secret: string;
  try {
    secret = decryptSecret({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag }, masterKey);
  } catch {
    return { expiresAt: null, invalid: true, expired: false };
  }
  const expiresAt = jwtExpiresAt(secret);
  if (!expiresAt) return { expiresAt: null, invalid: true, expired: false };
  return { expiresAt, invalid: false, expired: Date.parse(expiresAt) <= Date.now() };
};

const publicCredential = (row: CredentialRow, masterKey: Buffer) => {
  const inspection = inspectCredential(row, masterKey);
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    mask: `••••${row.id.slice(-4)}`,
    enabled: Boolean(row.enabled),
    status: !row.enabled || row.status === 'disabled' ? 'disabled' : inspection.invalid ? 'needs_review' : inspection.expired ? 'expired' : row.status,
    expiresAt: inspection.expiresAt,
    usedToday: Number(row.used_today || 0),
    cooldownUntil: row.cooldown_until,
    failureCount: row.failure_count,
    lastUsedAt: row.last_used_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

export class ControlStore {
  constructor(private readonly database: SqliteDatabase, private readonly masterKey: Buffer) {}

  async initialize(bootstrapPassword?: string, environment: Record<string, string | undefined> = {}): Promise<void> {
    await this.ensureApiTokenSchema();
    await this.ensureCredentialProviderSchema();
    await this.database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(nowIso()).run();
    const admin = await this.database.prepare("SELECT id FROM auth_identities WHERE kind='admin'").first<{ id: string }>();
    if (!admin && bootstrapPassword) await this.setPassword('admin', bootstrapPassword);
    await this.setDefault('frontend_password_enabled', false);
    await this.setDefault('api_auth_enabled', true);
    await this.setDefault('map_display_config', mapDisplayConfigFromEnvironment(environment));
    const browserCredential = browserMapCredentialFromEnvironment(environment);
    if (browserCredential && !await this.browserMapCredentialRow()) await this.createBrowserMapCredential(browserCredential);
  }

  private async ensureApiTokenSchema(): Promise<void> {
    const columns = (await this.database.prepare('PRAGMA table_info(api_tokens)').all<{ name: string }>()).results;
    const names = new Set(columns.map((column) => column.name));
    const missing = ['token_ciphertext', 'token_iv', 'token_tag'].filter((name) => !names.has(name));
    if (missing.length) {
      await this.database.exec('BEGIN IMMEDIATE');
      try {
        for (const column of missing) await this.database.exec(`ALTER TABLE api_tokens ADD COLUMN ${column} TEXT`);
        await this.database.prepare('INSERT OR IGNORE INTO control_migrations(version,applied_at) VALUES (4,?)').bind(nowIso()).run();
        await this.database.exec('COMMIT');
      } catch (error) {
        await this.database.exec('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } else {
      await this.database.prepare('INSERT OR IGNORE INTO control_migrations(version,applied_at) VALUES (4,?)').bind(nowIso()).run();
    }
  }

  private async ensureCredentialProviderSchema(): Promise<void> {
    const schema = await this.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_credentials'")
      .first<{ sql: string }>();
    if (!schema || schema.sql.includes("'onemap'")) {
      await this.database.prepare('INSERT OR IGNORE INTO control_migrations(version,applied_at) VALUES (2,?)').bind(nowIso()).run();
      return;
    }
    await this.database.exec('PRAGMA foreign_keys = OFF');
    try {
      await this.database.exec(`BEGIN IMMEDIATE;
        ALTER TABLE provider_usage_daily RENAME TO provider_usage_daily_legacy;
        ALTER TABLE provider_credentials RENAME TO provider_credentials_legacy;
        CREATE TABLE provider_credentials (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('amap','baidu','tencent','onemap')),
          label TEXT NOT NULL,
          secret_ciphertext TEXT NOT NULL,
          secret_iv TEXT NOT NULL,
          secret_tag TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
          status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','cooldown','quota_exhausted','needs_review','disabled')),
          weight INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 10000),
          qps_limit INTEGER NOT NULL DEFAULT 1 CHECK (qps_limit BETWEEN 1 AND 10000),
          daily_limit INTEGER NOT NULL DEFAULT 1000 CHECK (daily_limit BETWEEN 1 AND 100000000),
          quota_scope_id TEXT NOT NULL,
          cooldown_until TEXT,
          failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
          last_used_at TEXT,
          last_success_at TEXT,
          last_failure_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE provider_usage_daily (
          credential_id TEXT NOT NULL REFERENCES provider_credentials(id) ON DELETE CASCADE,
          usage_date TEXT NOT NULL,
          accepted_count INTEGER NOT NULL DEFAULT 0,
          rejected_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (credential_id,usage_date)
        );
        INSERT INTO provider_credentials SELECT * FROM provider_credentials_legacy;
        INSERT INTO provider_usage_daily SELECT * FROM provider_usage_daily_legacy;
        DROP TABLE provider_usage_daily_legacy;
        DROP TABLE provider_credentials_legacy;
        CREATE INDEX idx_provider_credentials_pick ON provider_credentials(provider,enabled,status,cooldown_until,last_used_at);
        INSERT OR IGNORE INTO control_migrations(version,applied_at) VALUES (2,datetime('now'));
        COMMIT;`);
    } catch (error) {
      await this.database.exec('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await this.database.exec('PRAGMA foreign_keys = ON');
    }
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

  async mapDisplayConfig(): Promise<MapDisplayConfig> {
    return normalizeMapDisplayConfig(await this.setting<unknown>('map_display_config', DEFAULT_MAP_DISPLAY_CONFIG));
  }

  async updateMapDisplayConfig(input: unknown): Promise<MapDisplayConfig> {
    const value = strictMapDisplayConfig(input);
    await this.setSetting('map_display_config', value);
    return value;
  }

  private async browserMapCredentialRow(): Promise<BrowserMapCredentialRow | null> {
    return await this.database.prepare("SELECT * FROM browser_map_credentials WHERE provider='amap'").first<BrowserMapCredentialRow>() || null;
  }

  async browserMapCredentialStatus(): Promise<{
    configured: boolean; enabled: boolean; label: string; mask: string; securityMask: string; status: 'healthy' | 'disabled' | 'needs_review'; lastUsedAt: string | null; updatedAt: string | null;
  }> {
    const row = await this.browserMapCredentialRow();
    if (!row) return { configured: false, enabled: false, label: '', mask: '', securityMask: '', status: 'disabled', lastUsedAt: null, updatedAt: null };
    try {
      const apiKey = decryptSecret({ ciphertext: row.api_key_ciphertext, iv: row.api_key_iv, tag: row.api_key_tag }, this.masterKey);
      const securityCode = decryptSecret({ ciphertext: row.security_code_ciphertext, iv: row.security_code_iv, tag: row.security_code_tag }, this.masterKey);
      return {
        configured: true,
        enabled: Boolean(row.enabled),
        label: row.label,
        mask: `••••${apiKey.slice(-4)}`,
        securityMask: `••••${securityCode.slice(-4)}`,
        status: row.enabled ? 'healthy' : 'disabled',
        lastUsedAt: row.last_used_at,
        updatedAt: row.updated_at
      };
    } catch {
      return { configured: false, enabled: false, label: row.label, mask: '', securityMask: '', status: 'needs_review', lastUsedAt: row.last_used_at, updatedAt: row.updated_at };
    }
  }

  async revealCredential(id: string): Promise<{ id: string; secret: string }> {
    const row = await this.database.prepare('SELECT * FROM provider_credentials WHERE id=?').bind(id).first<CredentialRow>();
    if (!row) throw new Error('CREDENTIAL_NOT_FOUND');
    try {
      return { id: row.id, secret: decryptSecret({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag }, this.masterKey) };
    } catch {
      throw new Error('INVALID_PROVIDER_CREDENTIAL');
    }
  }

  async revealBrowserMapCredential(): Promise<{ apiKey: string; securityCode: string }> {
    const row = await this.browserMapCredentialRow();
    if (!row) throw new Error('BROWSER_MAP_CREDENTIAL_NOT_FOUND');
    try {
      return {
        apiKey: decryptSecret({ ciphertext: row.api_key_ciphertext, iv: row.api_key_iv, tag: row.api_key_tag }, this.masterKey),
        securityCode: decryptSecret({ ciphertext: row.security_code_ciphertext, iv: row.security_code_iv, tag: row.security_code_tag }, this.masterKey)
      };
    } catch {
      throw new Error('INVALID_BROWSER_MAP_CREDENTIAL');
    }
  }

  async createBrowserMapCredential(input: BrowserMapCredentialInput): Promise<void> {
    if (await this.browserMapCredentialRow()) throw new Error('BROWSER_MAP_CREDENTIAL_EXISTS');
    if (!input || typeof input !== 'object') throw new Error('INVALID_BROWSER_MAP_CREDENTIAL');
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const securityCode = typeof input.securityCode === 'string' ? input.securityCode.trim() : '';
    const label = typeof input.label === 'string' ? input.label.trim().slice(0, 80) || 'AMap JS API' : 'AMap JS API';
    if (!apiKey || !securityCode || apiKey.length > 2048 || securityCode.length > 2048
      || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new Error('INVALID_BROWSER_MAP_CREDENTIAL');
    const encryptedKey = encryptSecret(apiKey, this.masterKey);
    const encryptedCode = encryptSecret(securityCode, this.masterKey);
    const now = nowIso();
    await this.database.prepare(`INSERT INTO browser_map_credentials(
      provider,label,api_key_ciphertext,api_key_iv,api_key_tag,security_code_ciphertext,security_code_iv,security_code_tag,enabled,created_at,updated_at
    ) VALUES ('amap',?,?,?,?,?,?,?,?,?,?)`).bind(
      label, encryptedKey.ciphertext, encryptedKey.iv, encryptedKey.tag,
      encryptedCode.ciphertext, encryptedCode.iv, encryptedCode.tag, input.enabled === false ? 0 : 1, now, now
    ).run();
  }

  async updateBrowserMapCredential(input: BrowserMapCredentialUpdate): Promise<void> {
    const row = await this.browserMapCredentialRow();
    if (!row) throw new Error('BROWSER_MAP_CREDENTIAL_NOT_FOUND');
    if (!input || typeof input !== 'object') throw new Error('INVALID_BROWSER_MAP_CREDENTIAL');
    if ((input.label !== undefined && typeof input.label !== 'string')
      || (input.apiKey !== undefined && typeof input.apiKey !== 'string')
      || (input.securityCode !== undefined && typeof input.securityCode !== 'string')
      || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new Error('INVALID_BROWSER_MAP_CREDENTIAL');
    const label = input.label?.trim().slice(0, 80) || row.label;
    const apiKey = input.apiKey?.trim();
    const securityCode = input.securityCode?.trim();
    if ((apiKey && apiKey.length > 2048) || (securityCode && securityCode.length > 2048)) throw new Error('INVALID_BROWSER_MAP_CREDENTIAL');
    const encryptedKey = apiKey ? encryptSecret(apiKey, this.masterKey) : null;
    const encryptedCode = securityCode ? encryptSecret(securityCode, this.masterKey) : null;
    await this.database.prepare(`UPDATE browser_map_credentials SET label=?,enabled=?,
      api_key_ciphertext=?,api_key_iv=?,api_key_tag=?,security_code_ciphertext=?,security_code_iv=?,security_code_tag=?,updated_at=?
      WHERE provider='amap'`).bind(
      label, input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
      encryptedKey?.ciphertext || row.api_key_ciphertext, encryptedKey?.iv || row.api_key_iv, encryptedKey?.tag || row.api_key_tag,
      encryptedCode?.ciphertext || row.security_code_ciphertext, encryptedCode?.iv || row.security_code_iv, encryptedCode?.tag || row.security_code_tag,
      nowIso()
    ).run();
  }

  async deleteBrowserMapCredential(): Promise<void> {
    await this.database.prepare("DELETE FROM browser_map_credentials WHERE provider='amap'").run();
  }

  async acquireBrowserMapCredential(): Promise<{ apiKey: string; securityCode: string } | null> {
    const row = await this.database.prepare("SELECT * FROM browser_map_credentials WHERE provider='amap' AND enabled=1")
      .first<BrowserMapCredentialRow>();
    if (!row) return null;
    try {
      const apiKey = decryptSecret({ ciphertext: row.api_key_ciphertext, iv: row.api_key_iv, tag: row.api_key_tag }, this.masterKey);
      const securityCode = decryptSecret({ ciphertext: row.security_code_ciphertext, iv: row.security_code_iv, tag: row.security_code_tag }, this.masterKey);
      await this.database.prepare("UPDATE browser_map_credentials SET last_used_at=? WHERE provider='amap'").bind(nowIso()).run();
      return { apiKey, securityCode };
    } catch { return null; }
  }

  async setPassword(kind: SessionRole, password: string, currentSessionToken?: string): Promise<void> {
    const value = await hashPassword(password);
    const now = nowIso();
    await this.database.prepare(`INSERT INTO auth_identities(id,kind,password_hash,password_salt,created_at,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET password_hash=excluded.password_hash,
      password_salt=excluded.password_salt,updated_at=excluded.updated_at`)
      .bind(randomUUID(), kind, value.hash, value.salt, now, now).run();
    if (currentSessionToken) {
      await this.database.prepare('DELETE FROM auth_sessions WHERE role=? AND id_hash<>?')
        .bind(kind, tokenHash(currentSessionToken)).run();
    } else {
      await this.database.prepare('DELETE FROM auth_sessions WHERE role=?').bind(kind).run();
    }
  }

  async updateAccessSettings(input: {
    frontendPasswordEnabled?: boolean;
    frontendPassword?: string;
    frontendPasswordConfirmation?: string;
    apiAuthEnabled?: boolean;
    adminPassword?: string;
    adminPasswordConfirmation?: string;
  }, currentSessionToken: string): Promise<void> {
    const frontendPassword = optionalPassword(input.frontendPassword, input.frontendPasswordConfirmation);
    const adminPassword = optionalPassword(input.adminPassword, input.adminPasswordConfirmation);
    if (input.frontendPasswordEnabled && !frontendPassword && !await this.hasIdentity('frontend')) {
      throw new Error('FRONTEND_PASSWORD_REQUIRED');
    }
    const [frontendHash, adminHash] = await Promise.all([
      frontendPassword ? hashPassword(frontendPassword) : undefined,
      adminPassword ? hashPassword(adminPassword) : undefined
    ]);
    const now = nowIso();
    const statements = [];
    if (frontendHash) {
      statements.push(this.database.prepare(`INSERT INTO auth_identities(id,kind,password_hash,password_salt,created_at,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET password_hash=excluded.password_hash,
        password_salt=excluded.password_salt,updated_at=excluded.updated_at`)
        .bind(randomUUID(), 'frontend', frontendHash.hash, frontendHash.salt, now, now));
      statements.push(this.database.prepare("DELETE FROM auth_sessions WHERE role='frontend'"));
    }
    if (adminHash) {
      statements.push(this.database.prepare(`INSERT INTO auth_identities(id,kind,password_hash,password_salt,created_at,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET password_hash=excluded.password_hash,
        password_salt=excluded.password_salt,updated_at=excluded.updated_at`)
        .bind(randomUUID(), 'admin', adminHash.hash, adminHash.salt, now, now));
      statements.push(currentSessionToken
        ? this.database.prepare("DELETE FROM auth_sessions WHERE role='admin' AND id_hash<>?").bind(tokenHash(currentSessionToken))
        : this.database.prepare("DELETE FROM auth_sessions WHERE role='admin'"));
    }
    if (input.frontendPasswordEnabled !== undefined) {
      statements.push(this.database.prepare(`INSERT INTO system_settings(key,value_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .bind('frontend_password_enabled', JSON.stringify(Boolean(input.frontendPasswordEnabled)), now));
    }
    if (input.apiAuthEnabled !== undefined) {
      statements.push(this.database.prepare(`INSERT INTO system_settings(key,value_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .bind('api_auth_enabled', JSON.stringify(Boolean(input.apiAuthEnabled)), now));
    }
    statements.push(this.database.prepare('INSERT INTO audit_events(actor,action,target,details_json,created_at) VALUES (?,?,?,?,?)')
      .bind('admin', 'settings.access.update', 'access', JSON.stringify({
        frontendPasswordEnabled: input.frontendPasswordEnabled,
        apiAuthEnabled: input.apiAuthEnabled,
        frontendPasswordChanged: Boolean(frontendPassword),
        adminPasswordChanged: Boolean(adminPassword)
      }), now));
    await this.database.batch(statements);
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

  async refreshSessionCsrf(token: string, role: SessionRole): Promise<string | null> {
    if (!token) return null;
    const csrf = opaqueToken(24);
    const now = nowIso();
    const result = await this.database.prepare(`UPDATE auth_sessions SET csrf_hash=?,last_seen_at=?
      WHERE id_hash=? AND role=? AND expires_at>?`).bind(tokenHash(csrf), now, tokenHash(token), role, now).run();
    return result.meta.changes ? csrf : null;
  }

  async deleteSession(token: string): Promise<void> {
    if (token) await this.database.prepare('DELETE FROM auth_sessions WHERE id_hash=?').bind(tokenHash(token)).run();
  }

  async createApiToken(input: { name: string; token?: string; scopes?: string[]; rateLimit: number; expiresAt?: string | null }): Promise<{ id: string; token: string }> {
    const name = input.name.trim();
    if (!name) throw new Error('TOKEN_NAME_REQUIRED');
    const rateLimit = Number(input.rateLimit);
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000) throw new Error('INVALID_TOKEN_RATE_LIMIT');
    const secret = validateTokenSecret(input.token?.trim() || `addr_${opaqueToken()}`);
    const hash = tokenHash(secret);
    if (await this.database.prepare('SELECT id FROM api_tokens WHERE token_hash=?').bind(hash).first<{ id: string }>()) {
      throw new Error('TOKEN_ALREADY_EXISTS');
    }
    const encrypted = encryptSecret(secret, this.masterKey);
    const id = randomUUID();
    const createdAt = nowIso();
    await this.database.prepare(`INSERT INTO api_tokens(
        id,name,token_prefix,token_hash,token_ciphertext,token_iv,token_tag,scopes_json,
        rate_limit_per_minute,expires_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, name.slice(0, 80), secret.slice(0, 12), hash, encrypted.ciphertext, encrypted.iv, encrypted.tag,
      JSON.stringify(normalizeTokenScopes(input.scopes)), rateLimit, normalizeTokenExpiry(input.expiresAt), createdAt
    ).run();
    return { id, token: secret };
  }

  async listApiTokens(): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.database.prepare(`SELECT id,name,scopes_json,rate_limit_per_minute,expires_at,revoked_at,created_at,
        token_ciphertext,token_iv,token_tag
      FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`).all<Record<string, unknown>>()).results;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: json(String(row.scopes_json || ''), ['*']),
      rate_limit_per_minute: Number(row.rate_limit_per_minute),
      expires_at: row.expires_at || null,
      revoked_at: row.revoked_at || null,
      created_at: row.created_at,
      token_mask: '••••••••••••',
      token_revealable: Boolean(row.token_ciphertext && row.token_iv && row.token_tag)
    }));
  }

  async revealApiToken(id: string): Promise<{ id: string; token: string }> {
    const row = await this.database.prepare(`SELECT id,token_hash,token_ciphertext,token_iv,token_tag FROM api_tokens WHERE id=?`)
      .bind(id).first<ApiTokenRow>();
    if (!row) throw new Error('API_TOKEN_NOT_FOUND');
    if (!row.token_ciphertext || !row.token_iv || !row.token_tag) throw new Error('API_TOKEN_SECRET_UNAVAILABLE');
    try {
      const token = decryptSecret({ ciphertext: row.token_ciphertext, iv: row.token_iv, tag: row.token_tag }, this.masterKey);
      if (tokenHash(token) !== row.token_hash) throw new Error('API_TOKEN_SECRET_UNAVAILABLE');
      return { id: row.id, token };
    } catch (error) {
      if (error instanceof Error && error.message === 'API_TOKEN_SECRET_UNAVAILABLE') throw error;
      throw new Error('API_TOKEN_SECRET_UNAVAILABLE');
    }
  }

  async updateApiToken(id: string, input: { scopes?: string[]; rateLimit?: number; expiresAt?: string | null }): Promise<void> {
    const existing = await this.database.prepare('SELECT id FROM api_tokens WHERE id=?').bind(id).first<{ id: string }>();
    if (!existing) throw new Error('API_TOKEN_NOT_FOUND');
    const updates: string[] = [];
    const bindings: unknown[] = [];
    if (input.scopes !== undefined) {
      updates.push('scopes_json=?');
      bindings.push(JSON.stringify(normalizeTokenScopes(input.scopes)));
    }
    if (input.rateLimit !== undefined) {
      const rateLimit = Number(input.rateLimit);
      if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000) throw new Error('INVALID_TOKEN_RATE_LIMIT');
      updates.push('rate_limit_per_minute=?');
      bindings.push(rateLimit);
    }
    if (Object.hasOwn(input, 'expiresAt')) {
      updates.push('expires_at=?');
      bindings.push(normalizeTokenExpiry(input.expiresAt));
    }
    if (!updates.length) return;
    bindings.push(id);
    await this.database.prepare(`UPDATE api_tokens SET ${updates.join(',')} WHERE id=?`).bind(...bindings).run();
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

  async addCredential(input: CredentialInput): Promise<string> {
    if (!['amap', 'baidu', 'tencent', 'onemap'].includes(input.provider) || !input.secret?.trim() || !input.label?.trim()) throw new Error('INVALID_PROVIDER_CREDENTIAL');
    const id = randomUUID();
    const encrypted = encryptSecret(input.secret.trim(), this.masterKey);
    const now = nowIso();
    const weight = boundedInteger(input.weight, 100, 1, 10000, 'INVALID_CREDENTIAL_WEIGHT');
    const qpsLimit = boundedInteger(input.qpsLimit, credentialProviderDefaults[input.provider].qps, 1, 10000, 'INVALID_CREDENTIAL_QPS');
    const dailyLimit = boundedInteger(input.dailyLimit, credentialProviderDefaults[input.provider].daily, 1, 100000000, 'INVALID_CREDENTIAL_DAILY_LIMIT');
    await this.database.prepare(`INSERT INTO provider_credentials(
      id,provider,label,secret_ciphertext,secret_iv,secret_tag,weight,qps_limit,daily_limit,quota_scope_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, input.provider, input.label.trim().slice(0, 80), encrypted.ciphertext, encrypted.iv, encrypted.tag,
      weight, qpsLimit, dailyLimit, input.quotaScopeId?.trim().slice(0, 120) || `${input.provider}:${id}`, now, now
    ).run();
    return id;
  }

  async ensureCredential(input: CredentialInput): Promise<{ id: string; created: boolean }> {
    const secret = input.secret?.trim();
    if (!secret) throw new Error('INVALID_PROVIDER_CREDENTIAL');
    const rows = (await this.database.prepare('SELECT * FROM provider_credentials WHERE provider=? ORDER BY created_at')
      .bind(input.provider).all<CredentialRow>()).results;
    for (const row of rows) {
      try {
        const existing = decryptSecret({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag }, this.masterKey);
        if (safeEqual(existing, secret)) return { id: row.id, created: false };
      } catch { /* an unreadable credential is left for administrator review */ }
    }
    return { id: await this.addCredential({ ...input, secret }), created: true };
  }

  async listCredentials(): Promise<Array<ReturnType<typeof publicCredential>>> {
    const date = quotaUsageDate();
    const rows = (await this.database.prepare(`SELECT credential.*,COALESCE(usage.accepted_count+usage.rejected_count,0) AS used_today
      FROM provider_credentials credential LEFT JOIN provider_usage_daily usage
      ON usage.credential_id=credential.id AND usage.usage_date=? ORDER BY provider,label`).bind(date).all<CredentialRow>()).results;
    return rows.map((row) => publicCredential(row, this.masterKey));
  }

  async availableProviders(): Promise<ProviderName[]> {
    const rows = (await this.database.prepare(`SELECT DISTINCT provider FROM provider_credentials
      WHERE provider IN ('amap','baidu','tencent') AND enabled=1 AND status NOT IN ('disabled','needs_review','quota_exhausted') ORDER BY provider`)
      .all<{ provider: ProviderName }>()).results;
    return rows.map((row) => row.provider);
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

  async acquireCredential(provider: CredentialProviderName): Promise<{ id: string; provider: CredentialProviderName; secret: string } | null> {
    const date = quotaUsageDate();
    const now = nowIso();
    const rows = (await this.database.prepare(`SELECT credential.*,
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
      ORDER BY credential.last_used_at IS NOT NULL,credential.last_used_at`).bind(date, provider, now, now, date).all<CredentialRow>()).results;
    const selected = rows.find((candidate) => {
      const inspection = inspectCredential(candidate, this.masterKey);
      return !inspection.invalid && !inspection.expired;
    });
    if (!selected) return null;
    await this.database.prepare('UPDATE provider_credentials SET last_used_at=?,status=? WHERE id=?')
      .bind(now, 'healthy', selected.id).run();
    return {
      id: selected.id,
      provider: selected.provider,
      secret: decryptSecret({ ciphertext: selected.secret_ciphertext, iv: selected.secret_iv, tag: selected.secret_tag }, this.masterKey)
    };
  }

  async acquireCredentialById(id: string): Promise<{ id: string; provider: CredentialProviderName; secret: string } | null> {
    const date = quotaUsageDate();
    const now = nowIso();
    const row = await this.database.prepare(`SELECT credential.*,
      COALESCE((SELECT SUM(scope_usage.accepted_count+scope_usage.rejected_count)
        FROM provider_credentials scope_credential JOIN provider_usage_daily scope_usage ON scope_usage.credential_id=scope_credential.id
        WHERE scope_credential.quota_scope_id=credential.quota_scope_id AND scope_usage.usage_date=?),0) AS used_today
      FROM provider_credentials credential
      WHERE credential.id=? AND credential.enabled=1 AND credential.status NOT IN ('disabled','needs_review','quota_exhausted')
      AND (credential.cooldown_until IS NULL OR credential.cooldown_until<=?)
      AND (credential.last_used_at IS NULL OR (julianday(?) - julianday(credential.last_used_at))*86400 >= 1.0/credential.qps_limit)
      AND COALESCE((SELECT SUM(scope_usage.accepted_count+scope_usage.rejected_count)
        FROM provider_credentials scope_credential JOIN provider_usage_daily scope_usage ON scope_usage.credential_id=scope_credential.id
        WHERE scope_credential.quota_scope_id=credential.quota_scope_id AND scope_usage.usage_date=?),0)<credential.daily_limit`)
      .bind(date, id, now, now, date).first<CredentialRow>();
    if (!row) return null;
    const inspection = inspectCredential(row, this.masterKey);
    if (inspection.invalid || inspection.expired) return null;
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
    const date = quotaUsageDate(now);
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
    const cooldown = outcome === 'quota' ? nextQuotaReset(now)
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
