import { randomUUID } from 'node:crypto';
import type { Database } from '../database/database.mjs';
import { decryptSecret, encryptSecret, hashPassword, opaqueToken, safeEqual, tokenHash, verifyPassword } from './security';
import {
  countryShortcutOverrides, effectiveCountryShortcuts, strictCountryShortcutConfig,
  type CountryShortcutMap
} from './country-shortcuts.ts';
import type { CountryCode, CountryShortcutConfig } from '../../src/domain/types.ts';

export type SessionRole = 'admin' | 'frontend';
export type ProviderName = 'amap' | 'baidu' | 'tencent';
export type ServiceProviderName = 'youdao' | 'geoapify' | 'google-geocoding' | 'mappls';
export type CredentialProviderName = ProviderName | 'onemap' | ServiceProviderName;
export const serviceProviderNames = ['youdao', 'geoapify', 'google-geocoding', 'mappls'] as const;
export const credentialProviderNames = ['amap', 'baidu', 'tencent', 'onemap', ...serviceProviderNames] as const;
export type CredentialOutcome = 'success' | 'qps' | 'quota' | 'auth' | 'network' | 'invalid';
export type QuotaPeriod = 'day' | 'month';
export interface ProviderQuotaObservation {
  used?: number; limit?: number; period?: QuotaPeriod; service?: string;
  resetAt?: string | null; retryAt?: string | null;
}
export interface CredentialAcquireOptions { excludeIds?: Iterable<string> }
export interface CredentialAvailability {
  eligible: boolean;
  configured: boolean;
  nextAvailableAt: string | null;
  reason: 'ready' | 'cooldown' | 'quota' | 'blocked' | 'unconfigured';
}
export interface CredentialInput {
  provider: CredentialProviderName; label: string; secret: string; weight?: number; qpsLimit?: number;
  quotaService?: string; quotaPeriod?: QuotaPeriod; quotaLimit?: number; quotaTimezoneOffset?: number;
  quotaScopeId?: string; dailyLimit?: number;
}
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
  ['AMAP_API_KEY', 'amap'], ['BAIDU_API_KEY', 'baidu'], ['TENCENT_API_KEY', 'tencent'], ['ONEMAP_ACCESS_TOKEN', 'onemap'],
  ['GEOAPIFY_API_KEY', 'geoapify'], ['GOOGLE_GEOCODING_API_KEY', 'google-geocoding'], ['MAPPLS_API_KEY', 'mappls']
] as const;

export interface YoudaoSecretParts { appKey: string; appSecret: string }
export const parseYoudaoSecret = (secret: string | undefined): YoudaoSecretParts | undefined => {
  if (!secret) return undefined;
  try {
    const parsed = JSON.parse(secret) as Partial<YoudaoSecretParts>;
    const appKey = typeof parsed.appKey === 'string' ? parsed.appKey.trim() : '';
    const appSecret = typeof parsed.appSecret === 'string' ? parsed.appSecret.trim() : '';
    return appKey && appSecret ? { appKey, appSecret } : undefined;
  } catch { return undefined; }
};

export const credentialsFromEnvironment = (environment: Record<string, string | undefined>): CredentialInput[] => {
  const values = environmentCredentialDefinitions.flatMap(([baseName, provider]) => {
    const names = [baseName, ...Object.keys(environment)
      .filter((name) => {
        if (!name.startsWith(`${baseName}_`)) return false;
        return /^\d+$/u.test(name.slice(baseName.length + 1));
      })
      .sort((left, right) => Number(left.slice(baseName.length + 1)) - Number(right.slice(baseName.length + 1)))];
    return names.flatMap((name): CredentialInput[] => {
      const secret = environment[name]?.trim();
      return secret ? [{ provider, label: name, secret }] : [];
    });
  });
  const appKey = environment.YOUDAO_APP_KEY?.trim();
  const appSecret = environment.YOUDAO_APP_SECRET?.trim();
  if (appKey && appSecret) values.push({ provider: 'youdao', label: 'YOUDAO_APP_KEY', secret: JSON.stringify({ appKey, appSecret }) });
  return values;
};

interface IdentityRow { password_hash: string; password_salt: string }
interface SessionRow { role: SessionRole; csrf_hash: string; expires_at: string }
interface ApiTokenRow {
  id: string; name: string; token_hash: string; token_ciphertext: string | null; token_iv: string | null; token_tag: string | null;
  scopes_json: string; rate_limit_per_minute: number; expires_at: string | null; revoked_at: string | null;
}
interface CredentialRow {
  id: string; provider: CredentialProviderName; label: string; secret_ciphertext: string; secret_iv: string; secret_tag: string;
  enabled: number; status: string; weight: number; qps_limit: number; daily_limit: number; quota_scope_id: string;
  quota_service: string; quota_period: QuotaPeriod; quota_limit: number; quota_timezone_offset: number;
  provider_reported_used: number | null; provider_reported_limit: number | null;
  provider_reported_reset_at: string | null; provider_reported_at: string | null;
  cooldown_until: string | null; failure_count: number; last_used_at: string | null; last_success_at: string | null;
  last_failure_at: string | null; created_at: string; updated_at: string; used_in_period?: number;
  quota_windows?: CredentialQuotaWindow[];
}
interface CredentialQuotaWindow {
  service: string; scopeId: string; period: QuotaPeriod; limit: number; timezoneOffset: number;
  source: string; used: number; resetAt: string; usageSource: 'local' | 'provider'; exhausted: boolean;
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
export const AMAP_PERSONAL_MONTHLY_LIMIT = 5_000;
export const credentialProviderDefaults: Record<CredentialProviderName, {
  qps: number; service: string; period: QuotaPeriod; limit: number; timezoneOffset: number;
}> = {
  amap: { qps: 3, service: 'place-search-v5', period: 'month', limit: AMAP_PERSONAL_MONTHLY_LIMIT, timezoneOffset: 480 },
  baidu: { qps: 3, service: 'place-search-v2', period: 'day', limit: 100, timezoneOffset: 480 },
  tencent: { qps: 5, service: 'place-search-v1', period: 'day', limit: 10_000, timezoneOffset: 480 },
  onemap: { qps: 1, service: 'search', period: 'day', limit: 100, timezoneOffset: 480 },
  youdao: { qps: 1, service: 'text-translate', period: 'month', limit: 100_000, timezoneOffset: 0 },
  geoapify: { qps: 5, service: 'geocode', period: 'day', limit: 3_000, timezoneOffset: 0 },
  'google-geocoding': { qps: 10, service: 'geocode', period: 'month', limit: 40_000, timezoneOffset: 0 },
  mappls: { qps: 5, service: 'nearby-place-details', period: 'day', limit: 1_000, timezoneOffset: 330 }
};
const quotaPeriodStart = (period: QuotaPeriod, offsetMinutes: number, date = new Date()): string => {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000).toISOString();
  return period === 'month' ? shifted.slice(0, 7) : shifted.slice(0, 10);
};
const nextQuotaReset = (period: QuotaPeriod, offsetMinutes: number, date = new Date()): Date => {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  if (period === 'month') shifted.setUTCMonth(shifted.getUTCMonth() + 1, 1);
  else shifted.setUTCDate(shifted.getUTCDate() + 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMinutes * 60_000);
};
const json = <T>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const syncGoalSnapshot = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  return snapshot.total && snapshot.administrativeCoverage && snapshot.regionalMinimums ? snapshot : null;
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
  const windows = row.quota_windows || [];
  const primary = windows.find((window) => window.service === row.quota_service && window.period === row.quota_period)
    || windows[0];
  const windowsExhausted = windows.some((window) => window.exhausted);
  const legacyQuotaExhausted = !windowsExhausted && row.status === 'quota_exhausted'
    && (!row.cooldown_until || Date.parse(row.cooldown_until) > Date.now());
  const quotaWindows = windows.map((window) => {
    const exhausted = window.exhausted || (legacyQuotaExhausted && window === primary);
    const used = exhausted ? Math.max(window.used, window.limit) : window.used;
    return {
      service: window.service, period: window.period, used, limit: window.limit,
      remaining: Math.max(0, window.limit - used), resetAt: window.resetAt,
      usageSource: window.usageSource, exhausted
    };
  });
  const publicPrimary = quotaWindows.find((window) => window.service === row.quota_service && window.period === row.quota_period)
    || quotaWindows[0];
  const quotaUsed = publicPrimary?.used ?? Number(row.used_in_period || 0);
  const quotaLimit = primary?.limit ?? row.quota_limit;
  const resetAt = primary?.resetAt || nextQuotaReset(row.quota_period, row.quota_timezone_offset).toISOString();
  const exhausted = quotaWindows.some((window) => window.exhausted) || quotaUsed >= quotaLimit;
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    mask: `••••${row.id.slice(-4)}`,
    enabled: Boolean(row.enabled),
    status: !row.enabled || row.status === 'disabled' ? 'disabled' : inspection.invalid ? 'needs_review' : inspection.expired ? 'expired' : exhausted ? 'quota_exhausted' : row.status,
    expiresAt: inspection.expiresAt,
    quotaService: row.quota_service,
    quotaPeriod: row.quota_period,
    quotaUsed,
    quotaLimit,
    quotaRemaining: Math.max(0, quotaLimit - quotaUsed),
    quotaResetAt: resetAt,
    quotaUsageSource: primary?.usageSource || 'local',
    quotaWindows,
    providerReportedAt: windows.some((window) => window.usageSource === 'provider') ? row.provider_reported_at : null,
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
  constructor(private readonly database: Database, private readonly masterKey: Buffer) {}

  async initialize(bootstrapPassword?: string, environment: Record<string, string | undefined> = {}): Promise<void> {
    await this.database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(nowIso()).run();
    const admin = await this.database.prepare("SELECT id FROM auth_identities WHERE kind='admin'").first<{ id: string }>();
    if (!admin && bootstrapPassword) await this.setPassword('admin', bootstrapPassword);
    await this.setDefault('frontend_password_enabled', false);
    await this.setDefault('api_auth_enabled', true);
    await this.setDefault('google_translation_enabled', environmentBoolean(environment.GOOGLE_TRANSLATION_ENABLED, true));
    await this.setDefault('map_display_config', mapDisplayConfigFromEnvironment(environment));
    const browserCredential = browserMapCredentialFromEnvironment(environment);
    if (browserCredential && !await this.browserMapCredentialRow()) await this.createBrowserMapCredential(browserCredential);
    await this.ensureQuotaWindows();
  }

  async status(): Promise<{ initialized: boolean; frontendPasswordEnabled: boolean; apiAuthEnabled: boolean }> {
    const admin = await this.database.prepare("SELECT id FROM auth_identities WHERE kind='admin'").first<{ id: string }>();
    return {
      initialized: Boolean(admin),
      frontendPasswordEnabled: await this.setting('frontend_password_enabled', false),
      apiAuthEnabled: true
    };
  }

  async providerRequestsToday(date = new Date().toISOString().slice(0, 10)): Promise<number> {
    const total = await this.database.prepare(`SELECT COALESCE(SUM(accepted_count+rejected_count),0) AS total
      FROM provider_usage_daily WHERE usage_date=?`).bind(date).first<number>('total');
    return Number(total || 0);
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
    await this.database.prepare(`INSERT INTO system_settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT (key) DO NOTHING`)
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

  async countryShortcuts(): Promise<CountryShortcutMap> {
    return effectiveCountryShortcuts(await this.setting<unknown>('country_shortcuts', {}));
  }

  async countryShortcutAdminSettings(): Promise<Array<CountryShortcutConfig & { customized: boolean }>> {
    const raw = await this.setting<unknown>('country_shortcuts', {});
    const overrides = countryShortcutOverrides(raw);
    return Object.values(effectiveCountryShortcuts(raw)).map((value) => ({
      ...value,
      customized: Boolean(overrides[value.countryCode])
    }));
  }

  async updateCountryShortcuts(countryCode: CountryCode, input: unknown): Promise<CountryShortcutConfig> {
    const value = strictCountryShortcutConfig(countryCode, input);
    const overrides = countryShortcutOverrides(await this.setting<unknown>('country_shortcuts', {}));
    overrides[countryCode] = value;
    await this.setSetting('country_shortcuts', overrides);
    return value;
  }

  async resetCountryShortcuts(countryCode: CountryCode): Promise<CountryShortcutConfig> {
    const overrides = countryShortcutOverrides(await this.setting<unknown>('country_shortcuts', {}));
    delete overrides[countryCode];
    await this.setSetting('country_shortcuts', overrides);
    return (await this.countryShortcuts())[countryCode];
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
    statements.push(this.database.prepare('INSERT INTO audit_events(actor,action,target,details_json,created_at) VALUES (?,?,?,?,?)')
      .bind('admin', 'settings.access.update', 'access', JSON.stringify({
        frontendPasswordEnabled: input.frontendPasswordEnabled,
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
    if (!(credentialProviderNames as readonly string[]).includes(input.provider) || !input.secret?.trim() || !input.label?.trim()) throw new Error('INVALID_PROVIDER_CREDENTIAL');
    if (input.provider === 'youdao' && !parseYoudaoSecret(input.secret.trim())) throw new Error('INVALID_PROVIDER_CREDENTIAL');
    const id = randomUUID();
    const encrypted = encryptSecret(input.secret.trim(), this.masterKey);
    const now = nowIso();
    const weight = boundedInteger(input.weight, 100, 1, 10000, 'INVALID_CREDENTIAL_WEIGHT');
    const defaults = credentialProviderDefaults[input.provider];
    const qpsLimit = boundedInteger(input.qpsLimit, defaults.qps, 1, 10000, 'INVALID_CREDENTIAL_QPS');
    const quotaPeriod = input.quotaPeriod || defaults.period;
    if (!['day', 'month'].includes(quotaPeriod)) throw new Error('INVALID_CREDENTIAL_QUOTA_PERIOD');
    const quotaLimit = boundedInteger(input.quotaLimit ?? input.dailyLimit, defaults.limit, 1, 100000000, 'INVALID_CREDENTIAL_QUOTA_LIMIT');
    const timezoneOffset = boundedInteger(input.quotaTimezoneOffset, defaults.timezoneOffset, -720, 840, 'INVALID_CREDENTIAL_QUOTA_TIMEZONE');
    const quotaService = input.quotaService?.trim().slice(0, 80) || defaults.service;
    await this.database.prepare(`INSERT INTO provider_credentials(
      id,provider,label,secret_ciphertext,secret_iv,secret_tag,weight,qps_limit,daily_limit,
      quota_service,quota_period,quota_limit,quota_timezone_offset,quota_scope_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, input.provider, input.label.trim().slice(0, 80), encrypted.ciphertext, encrypted.iv, encrypted.tag,
      weight, qpsLimit, quotaLimit, quotaService, quotaPeriod, quotaLimit, timezoneOffset,
      input.quotaScopeId?.trim().slice(0, 120) || `${input.provider}:${quotaService}:${id}`, now, now
    ).run();
    const row = await this.database.prepare('SELECT quota_scope_id FROM provider_credentials WHERE id=?').bind(id)
      .first<{ quota_scope_id: string }>();
    await this.database.prepare(`INSERT INTO provider_quota_windows(
      credential_id,service,scope_id,period,limit_count,timezone_offset,source,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,'admin',1,?,?)`).bind(
      id, quotaService, row!.quota_scope_id, quotaPeriod, quotaLimit, timezoneOffset, now, now
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

  async youdaoCredentialStatus(): Promise<{ configured: boolean; appKeyMask: string }> {
    const row = await this.database.prepare("SELECT * FROM provider_credentials WHERE provider='youdao' ORDER BY created_at")
      .first<CredentialRow>();
    if (!row) return { configured: false, appKeyMask: '' };
    try {
      const parts = parseYoudaoSecret(decryptSecret({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag }, this.masterKey));
      if (!parts) return { configured: false, appKeyMask: '' };
      return { configured: true, appKeyMask: `${parts.appKey.slice(0, 4)}****` };
    } catch {
      return { configured: false, appKeyMask: '' };
    }
  }

  async upsertYoudaoCredential(appKey: string, appSecret: string): Promise<void> {
    const key = appKey?.trim();
    const secretPart = appSecret?.trim();
    if (!key || !secretPart || key.length > 2048 || secretPart.length > 2048) throw new Error('INVALID_PROVIDER_CREDENTIAL');
    const secret = JSON.stringify({ appKey: key, appSecret: secretPart });
    const row = await this.database.prepare("SELECT id FROM provider_credentials WHERE provider='youdao' ORDER BY created_at")
      .first<{ id: string }>();
    if (row) await this.updateCredential(row.id, { secret, enabled: true });
    else await this.addCredential({ provider: 'youdao', label: 'YOUDAO_APP_KEY', secret });
  }

  private async ensureQuotaWindows(): Promise<void> {
    await this.database.prepare(`INSERT INTO provider_quota_windows(
      credential_id,service,scope_id,period,limit_count,timezone_offset,source,enabled,created_at,updated_at
    ) SELECT id,quota_service,quota_scope_id,quota_period,quota_limit,quota_timezone_offset,'default',enabled,created_at,updated_at
      FROM provider_credentials ON CONFLICT(credential_id,service,period) DO NOTHING`).run();
  }

  async listCredentials(): Promise<Array<ReturnType<typeof publicCredential>>> {
    await this.resetExpiredQuotaStates();
    const rows = (await this.database.prepare('SELECT * FROM provider_credentials ORDER BY provider,label').all<CredentialRow>()).results;
    await Promise.all(rows.map(async (row) => { row.quota_windows = await this.credentialQuotaWindows(row); }));
    return rows.map((row) => publicCredential(row, this.masterKey));
  }

  async availableProviders(): Promise<ProviderName[]> {
    await this.resetExpiredQuotaStates();
    const rows = (await this.database.prepare(`SELECT * FROM provider_credentials
      WHERE provider IN ('amap','baidu','tencent') AND enabled=1 AND status NOT IN ('disabled','needs_review')
      AND (cooldown_until IS NULL OR cooldown_until<=?) ORDER BY provider,last_used_at`).bind(nowIso())
      .all<CredentialRow>()).results;
    const providers = new Set<ProviderName>();
    for (const row of rows) {
      const inspection = inspectCredential(row, this.masterKey);
      if (!inspection.invalid && !inspection.expired && await this.quotaAvailable(row)) providers.add(row.provider as ProviderName);
    }
    return [...providers];
  }

  async credentialAvailability(providers: CredentialProviderName[]): Promise<CredentialAvailability> {
    await this.resetExpiredQuotaStates();
    const selectedProviders = [...new Set(providers)];
    if (!selectedProviders.length) return { eligible: false, configured: false, nextAvailableAt: null, reason: 'unconfigured' };
    const placeholders = selectedProviders.map(() => '?').join(',');
    const rows = (await this.database.prepare(`SELECT * FROM provider_credentials
      WHERE provider IN (${placeholders}) AND enabled=1 ORDER BY provider,last_used_at`).bind(...selectedProviders)
      .all<CredentialRow>()).results;
    if (!rows.length) return { eligible: false, configured: false, nextAvailableAt: null, reason: 'unconfigured' };
    let nextAvailableAt: string | null = null;
    let nextReason: 'cooldown' | 'quota' | null = null;
    for (const row of rows) {
      const inspection = inspectCredential(row, this.masterKey);
      if (inspection.invalid || inspection.expired || row.status === 'disabled' || row.status === 'needs_review') continue;
      const quotaWindows = await this.credentialQuotaWindows(row);
      const quotaAvailable = !quotaWindows.some((window) => window.exhausted);
      const cooldownAt = row.cooldown_until && Date.parse(row.cooldown_until) > Date.now() ? row.cooldown_until : null;
      const pacingTime = row.last_used_at ? Date.parse(row.last_used_at) + 1000 / row.qps_limit : 0;
      const pacingAt = Number.isFinite(pacingTime) && pacingTime > Date.now() ? new Date(pacingTime).toISOString() : null;
      if (quotaAvailable && !cooldownAt && !pacingAt) return { eligible: true, configured: true, nextAvailableAt: nowIso(), reason: 'ready' };
      const quotaResetAt = quotaWindows.filter((window) => window.exhausted)
        .map((window) => window.resetAt).sort((left, right) => Date.parse(left) - Date.parse(right))[0] || null;
      const candidate = !quotaAvailable
        ? quotaResetAt || cooldownAt || nextQuotaReset(row.quota_period, row.quota_timezone_offset).toISOString()
        : cooldownAt || pacingAt;
      const reason = !quotaAvailable || row.status === 'quota_exhausted' ? 'quota' : 'cooldown';
      if (candidate && (!nextAvailableAt || Date.parse(candidate) < Date.parse(nextAvailableAt))) {
        nextAvailableAt = candidate;
        nextReason = reason;
      }
    }
    if (nextReason) return { eligible: false, configured: true, nextAvailableAt, reason: nextReason };
    return { eligible: false, configured: true, nextAvailableAt: null, reason: 'blocked' };
  }

  async updateCredential(id: string, input: Record<string, unknown>): Promise<void> {
    const current = await this.database.prepare('SELECT * FROM provider_credentials WHERE id=?').bind(id).first<CredentialRow>();
    if (!current) throw new Error('CREDENTIAL_NOT_FOUND');
    const label = String(input.label ?? current.label).trim().slice(0, 80);
    const quotaScopeId = String(input.quotaScopeId ?? current.quota_scope_id).trim().slice(0, 120);
    if (!label || !quotaScopeId) throw new Error('INVALID_PROVIDER_CREDENTIAL');
    const weight = boundedInteger(input.weight, current.weight, 1, 10000, 'INVALID_CREDENTIAL_WEIGHT');
    const qpsLimit = boundedInteger(input.qpsLimit, current.qps_limit, 1, 10000, 'INVALID_CREDENTIAL_QPS');
    const quotaPeriod = String(input.quotaPeriod ?? current.quota_period) as QuotaPeriod;
    if (!['day', 'month'].includes(quotaPeriod)) throw new Error('INVALID_CREDENTIAL_QUOTA_PERIOD');
    const quotaLimit = boundedInteger(input.quotaLimit ?? input.dailyLimit, current.quota_limit, 1, 100000000, 'INVALID_CREDENTIAL_QUOTA_LIMIT');
    const timezoneOffset = boundedInteger(input.quotaTimezoneOffset, current.quota_timezone_offset, -720, 840, 'INVALID_CREDENTIAL_QUOTA_TIMEZONE');
    const quotaService = String(input.quotaService ?? current.quota_service).trim().slice(0, 80);
    if (!quotaService) throw new Error('INVALID_PROVIDER_CREDENTIAL');
    let encrypted = {
      ciphertext: current.secret_ciphertext,
      iv: current.secret_iv,
      tag: current.secret_tag
    };
    let secretChanged = false;
    if (typeof input.secret === 'string' && input.secret.trim()) {
      const nextSecret = input.secret.trim();
      if (current.provider === 'youdao' && !parseYoudaoSecret(nextSecret)) throw new Error('INVALID_PROVIDER_CREDENTIAL');
      let existingSecret = '';
      try {
        existingSecret = decryptSecret(encrypted, this.masterKey);
      } catch { /* replacing an unreadable credential is allowed */ }
      secretChanged = !existingSecret || !safeEqual(existingSecret, nextSecret);
      if (secretChanged) encrypted = encryptSecret(nextSecret, this.masterKey);
    }
    const enabled = input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0;
    await this.database.prepare(`UPDATE provider_credentials SET label=?,enabled=?,weight=?,qps_limit=?,daily_limit=?,
      quota_service=?,quota_period=?,quota_limit=?,quota_timezone_offset=?,quota_scope_id=?,
      secret_ciphertext=?,secret_iv=?,secret_tag=?,
      status=CASE WHEN ?=0 THEN 'disabled' WHEN ?=1 THEN 'healthy' WHEN status='disabled' THEN 'healthy' ELSE status END,
      cooldown_until=CASE WHEN ?=1 THEN NULL ELSE cooldown_until END,
      failure_count=CASE WHEN ?=1 THEN 0 ELSE failure_count END,
      last_failure_at=CASE WHEN ?=1 THEN NULL ELSE last_failure_at END,
      provider_reported_used=CASE WHEN ?=1 THEN NULL ELSE provider_reported_used END,
      provider_reported_limit=CASE WHEN ?=1 THEN NULL ELSE provider_reported_limit END,
      provider_reported_reset_at=CASE WHEN ?=1 THEN NULL ELSE provider_reported_reset_at END,
      provider_reported_at=CASE WHEN ?=1 THEN NULL ELSE provider_reported_at END,
      updated_at=? WHERE id=?`).bind(
      label, enabled, weight, qpsLimit, quotaLimit,
      quotaService, quotaPeriod, quotaLimit, timezoneOffset, quotaScopeId,
      encrypted.ciphertext, encrypted.iv, encrypted.tag,
      enabled, secretChanged ? 1 : 0,
      secretChanged ? 1 : 0, secretChanged ? 1 : 0, secretChanged ? 1 : 0,
      secretChanged ? 1 : 0, secretChanged ? 1 : 0, secretChanged ? 1 : 0, secretChanged ? 1 : 0,
      nowIso(), id
    ).run();
    const updatedAt = nowIso();
    await this.database.prepare(`INSERT INTO provider_quota_windows(
      credential_id,service,scope_id,period,limit_count,timezone_offset,source,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,'admin',?,?,?) ON CONFLICT(credential_id,service,period) DO UPDATE SET
      scope_id=excluded.scope_id,limit_count=excluded.limit_count,timezone_offset=excluded.timezone_offset,
      source='admin',enabled=excluded.enabled,updated_at=excluded.updated_at`).bind(
      id, quotaService, quotaScopeId, quotaPeriod, quotaLimit, timezoneOffset, enabled, current.created_at, updatedAt
    ).run();
    if (secretChanged) {
      await this.database.batch([
        this.database.prepare('DELETE FROM provider_usage_daily WHERE credential_id=?').bind(id),
        this.database.prepare('DELETE FROM provider_usage_periods WHERE credential_id=?').bind(id),
        this.database.prepare('DELETE FROM provider_quota_observations WHERE credential_id=?').bind(id)
      ]);
    }
  }

  async deleteCredential(id: string): Promise<void> {
    await this.database.prepare('DELETE FROM provider_credentials WHERE id=?').bind(id).run();
  }

  async acquireCredential(
    provider: CredentialProviderName,
    options: CredentialAcquireOptions = {}
  ): Promise<{ id: string; provider: CredentialProviderName; secret: string } | null> {
    await this.resetExpiredQuotaStates();
    const now = nowIso();
    const excluded = new Set(options.excludeIds || []);
    const rows = (await this.database.prepare(`SELECT credential.* FROM provider_credentials credential
      WHERE credential.provider=? AND credential.enabled=1 AND credential.status NOT IN ('disabled','needs_review')
      AND (credential.cooldown_until IS NULL OR credential.cooldown_until<=?)
      ORDER BY credential.last_used_at IS NOT NULL,credential.last_used_at,credential.created_at,credential.id`)
      .bind(provider, now).all<CredentialRow>()).results;
    let selected: CredentialRow | undefined;
    for (const candidate of rows) {
      if (excluded.has(candidate.id)) continue;
      if (candidate.last_used_at && Date.parse(candidate.last_used_at) + 1000 / candidate.qps_limit > Date.parse(now)) continue;
      const inspection = inspectCredential(candidate, this.masterKey);
      if (!inspection.invalid && !inspection.expired && await this.quotaAvailable(candidate)) { selected = candidate; break; }
    }
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
    await this.resetExpiredQuotaStates();
    const now = nowIso();
    const row = await this.database.prepare('SELECT * FROM provider_credentials WHERE id=?').bind(id).first<CredentialRow>();
    if (!row) return null;
    if (!row.enabled || ['disabled', 'needs_review'].includes(row.status)
      || (row.cooldown_until && Date.parse(row.cooldown_until) > Date.parse(now))
      || (row.last_used_at && Date.parse(row.last_used_at) + 1000 / row.qps_limit > Date.parse(now))) return null;
    const inspection = inspectCredential(row, this.masterKey);
    if (inspection.invalid || inspection.expired || !await this.quotaAvailable(row)) return null;
    await this.database.prepare('UPDATE provider_credentials SET last_used_at=?,status=? WHERE id=?')
      .bind(now, 'healthy', row.id).run();
    return {
      id: row.id,
      provider: row.provider,
      secret: decryptSecret({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag }, this.masterKey)
    };
  }

  async reportCredential(id: string, outcome: CredentialOutcome, observation?: ProviderQuotaObservation): Promise<void> {
    const now = new Date();
    const row = await this.database.prepare('SELECT * FROM provider_credentials WHERE id=?').bind(id).first<CredentialRow>();
    if (!row) return;
    const date = quotaPeriodStart('day', row.quota_timezone_offset, now);
    await this.database.prepare(`INSERT INTO provider_usage_daily(credential_id,usage_date,accepted_count,rejected_count)
      VALUES (?,?,?,?) ON CONFLICT(credential_id,usage_date) DO UPDATE SET
      accepted_count=provider_usage_daily.accepted_count+excluded.accepted_count,
      rejected_count=provider_usage_daily.rejected_count+excluded.rejected_count`)
      .bind(id, date, outcome === 'success' ? 1 : 0, outcome === 'success' ? 0 : 1).run();
    for (const periodStart of new Set([
      quotaPeriodStart('day', row.quota_timezone_offset, now),
      quotaPeriodStart('month', row.quota_timezone_offset, now)
    ])) {
      await this.database.prepare(`INSERT INTO provider_usage_periods(credential_id,period_start,accepted_count,rejected_count)
        VALUES (?,?,?,?) ON CONFLICT(credential_id,period_start) DO UPDATE SET
        accepted_count=provider_usage_periods.accepted_count+excluded.accepted_count,
        rejected_count=provider_usage_periods.rejected_count+excluded.rejected_count`)
        .bind(id, periodStart, outcome === 'success' ? 1 : 0, outcome === 'success' ? 0 : 1).run();
    }
    if (observation && Number.isSafeInteger(observation.used) && Number.isSafeInteger(observation.limit)
      && Number(observation.used) >= 0 && Number(observation.limit) > 0) {
      const period = observation.period || row.quota_period;
      const service = observation.service?.trim().slice(0, 80) || row.quota_service;
      const resetAt = observation.resetAt && Number.isFinite(Date.parse(observation.resetAt))
        ? new Date(observation.resetAt).toISOString() : nextQuotaReset(period, row.quota_timezone_offset, now).toISOString();
      await this.database.prepare(`INSERT INTO provider_quota_windows(
        credential_id,service,scope_id,period,limit_count,timezone_offset,source,enabled,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,'provider',1,?,?) ON CONFLICT(credential_id,service,period) DO UPDATE SET
        limit_count=excluded.limit_count,source='provider',enabled=1,updated_at=excluded.updated_at`).bind(
        id, service, row.quota_scope_id, period, observation.limit, row.quota_timezone_offset, now.toISOString(), now.toISOString()
      ).run();
      await this.database.prepare(`INSERT INTO provider_quota_observations(
        credential_id,service,period,used_count,limit_count,reset_at,observed_at,source
      ) VALUES (?,?,?,?,?,?,?,'provider') ON CONFLICT(credential_id,service,period) DO UPDATE SET
        used_count=excluded.used_count,limit_count=excluded.limit_count,reset_at=excluded.reset_at,
        observed_at=excluded.observed_at,source='provider'`).bind(
        id, service, period, observation.used, observation.limit, resetAt, now.toISOString()
      ).run();
      await this.database.prepare(`UPDATE provider_credentials SET provider_reported_used=?,provider_reported_limit=?,
        provider_reported_reset_at=?,provider_reported_at=? WHERE id=?`)
        .bind(observation.used, observation.limit, resetAt, now.toISOString(), id).run();
    }
    if (outcome === 'success') {
      await this.database.prepare(`UPDATE provider_credentials SET status='healthy',failure_count=0,cooldown_until=NULL,
        last_success_at=?,updated_at=? WHERE id=?`).bind(now.toISOString(), now.toISOString(), id).run();
      return;
    }
    const failures = Number(row.failure_count || 0) + 1;
    const reportedRetryAt = observation?.retryAt && Number.isFinite(Date.parse(observation.retryAt))
      ? new Date(observation.retryAt) : null;
    const quotaPeriod = observation?.period || row.quota_period;
    const cooldown = outcome === 'quota'
      ? reportedRetryAt && reportedRetryAt.getTime() > now.getTime() ? reportedRetryAt : nextQuotaReset(quotaPeriod, row.quota_timezone_offset, now)
      : reportedRetryAt && reportedRetryAt.getTime() > now.getTime() ? reportedRetryAt
        : new Date(now.getTime() + Math.min(300000, 1000 * 2 ** Math.min(failures, 8)));
    const status = outcome === 'auth' || outcome === 'invalid' ? 'needs_review' : outcome === 'quota' ? 'quota_exhausted' : 'cooldown';
    await this.database.prepare(`UPDATE provider_credentials SET status=?,failure_count=?,cooldown_until=?,last_failure_at=?,updated_at=? WHERE id=?`)
      .bind(status, failures, cooldown.toISOString(), now.toISOString(), now.toISOString(), id).run();
    if (outcome === 'quota') {
      const service = observation?.service?.trim().slice(0, 80) || row.quota_service;
      await this.database.prepare(`INSERT INTO provider_quota_windows(
        credential_id,service,scope_id,period,limit_count,timezone_offset,source,enabled,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,'provider',1,?,?) ON CONFLICT(credential_id,service,period) DO NOTHING`).bind(
        id, service, row.quota_scope_id, quotaPeriod, row.quota_limit, row.quota_timezone_offset,
        now.toISOString(), now.toISOString()
      ).run();
      const window = await this.database.prepare(`SELECT limit_count FROM provider_quota_windows
        WHERE credential_id=? AND service=? AND period=?`).bind(id, service, quotaPeriod)
        .first<{ limit_count: number }>();
      const limit = Number(window?.limit_count || row.quota_limit);
      await this.database.prepare(`INSERT INTO provider_quota_observations(
        credential_id,service,period,used_count,limit_count,reset_at,observed_at,source
      ) VALUES (?,?,?,?,?,?,?,'provider') ON CONFLICT(credential_id,service,period) DO UPDATE SET
        used_count=excluded.used_count,limit_count=excluded.limit_count,reset_at=excluded.reset_at,
        observed_at=excluded.observed_at,source='provider'`).bind(
        id, service, quotaPeriod, limit, limit, cooldown.toISOString(), now.toISOString()
      ).run();
      await this.database.prepare(`UPDATE provider_credentials SET provider_reported_used=?,
        provider_reported_limit=?,provider_reported_reset_at=?,provider_reported_at=? WHERE id=?`)
        .bind(limit, limit, cooldown.toISOString(), now.toISOString(), id).run();
    }
  }

  private async quotaUsage(period: QuotaPeriod, service: string, scopeId: string, timezoneOffset: number, date = new Date()): Promise<number> {
    const periodStart = quotaPeriodStart(period, timezoneOffset, date);
    return Number(await this.database.prepare(`SELECT COALESCE(SUM(usage.accepted_count+usage.rejected_count),0) AS total
      FROM provider_credentials credential JOIN provider_usage_periods usage ON usage.credential_id=credential.id
      WHERE credential.quota_scope_id=? AND credential.quota_service=? AND usage.period_start=?`)
      .bind(scopeId, service, periodStart).first('total') || 0);
  }

  private async credentialQuotaWindows(row: CredentialRow, date = new Date()): Promise<CredentialQuotaWindow[]> {
    const rows = (await this.database.prepare(`SELECT quota_window.service,quota_window.scope_id,quota_window.period,quota_window.limit_count,
      quota_window.timezone_offset,quota_window.source,observation.used_count,observation.limit_count AS observed_limit,
      observation.reset_at,observation.observed_at
      FROM provider_quota_windows quota_window LEFT JOIN provider_quota_observations observation
        ON observation.credential_id=quota_window.credential_id AND observation.service=quota_window.service AND observation.period=quota_window.period
      WHERE quota_window.credential_id=? AND quota_window.enabled=1 ORDER BY quota_window.period,quota_window.service`).bind(row.id).all<Record<string, unknown>>()).results;
    if (!rows.length) {
      rows.push({
        service: row.quota_service, scope_id: row.quota_scope_id, period: row.quota_period,
        limit_count: row.quota_limit, timezone_offset: row.quota_timezone_offset, source: 'default'
      });
    }
    return Promise.all(rows.map(async (window) => {
      const period = String(window.period) as QuotaPeriod;
      const service = String(window.service);
      const scopeId = String(window.scope_id);
      const timezoneOffset = Number(window.timezone_offset || 0);
      const localUsed = await this.quotaUsage(period, service, scopeId, timezoneOffset, date);
      const observedCurrent = window.observed_at && (!window.reset_at || Date.parse(String(window.reset_at)) > date.getTime());
      const limit = observedCurrent && window.observed_limit !== null
        ? Number(window.observed_limit) : Number(window.limit_count);
      const used = Math.max(localUsed, observedCurrent ? Number(window.used_count || 0) : 0);
      const resetAt = observedCurrent && window.reset_at
        ? new Date(String(window.reset_at)).toISOString()
        : nextQuotaReset(period, timezoneOffset, date).toISOString();
      return {
        service, scopeId, period, limit, timezoneOffset, source: String(window.source || 'default'),
        used, resetAt, usageSource: observedCurrent ? 'provider' as const : 'local' as const,
        exhausted: used >= limit
      };
    }));
  }

  private async quotaAvailable(row: CredentialRow): Promise<boolean> {
    return !(await this.credentialQuotaWindows(row)).some((window) => window.exhausted);
  }

  private async resetExpiredQuotaStates(): Promise<void> {
    const now = nowIso();
    await this.database.prepare('DELETE FROM provider_quota_observations WHERE reset_at IS NOT NULL AND reset_at<=?').bind(now).run();
    await this.database.prepare(`UPDATE provider_credentials SET status='healthy',cooldown_until=NULL,
      provider_reported_used=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_used END,
      provider_reported_limit=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_limit END,
      provider_reported_reset_at=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_reset_at END,
      provider_reported_at=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_at END,updated_at=?
      WHERE status IN ('cooldown','quota_exhausted') AND cooldown_until IS NOT NULL AND cooldown_until<=?`).bind(now, now).run();
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
    if (kind.startsWith('china')) {
      await this.database.prepare(`INSERT INTO sync_run_countries(
        run_id,country_code,source_id,trigger_name,status,before_goals_json,after_goals_json,created_at,updated_at
      ) VALUES (?,'CN','china-map-providers','automatic','queued','{}','{}',?,?)
        ON CONFLICT(run_id,country_code,source_id) DO NOTHING`).bind(id, now, now).run();
    }
    return id;
  }

  async updateRun(id: string, status: string, progress: Record<string, unknown>, error?: { code: string; message: string }): Promise<void> {
    const now = nowIso();
    await this.database.prepare(`UPDATE sync_runs SET status=?,progress_json=?,error_code=?,error_message=?,
      started_at=COALESCE(started_at,?),completed_at=CASE WHEN ? IN ('succeeded','failed','cancelled','needs_review') THEN ? ELSE completed_at END,updated_at=? WHERE id=?`)
      .bind(status, JSON.stringify(progress), error?.code || null, error?.message?.slice(0, 1000) || null, now, status, now, now, id).run();
    const accepted = Number(progress.accepted);
    await this.database.prepare(`UPDATE sync_run_countries SET status=?,started_at=COALESCE(started_at,?),
      completed_at=CASE WHEN ? IN ('succeeded','failed','cancelled','needs_review') THEN ? ELSE completed_at END,
      heartbeat_at=?,net_growth=CASE WHEN ? THEN ? ELSE net_growth END,error_code=?,error_message=?,updated_at=? WHERE run_id=?`)
      .bind(status, now, status, now, now, Number.isFinite(accepted) ? 1 : 0, Number.isFinite(accepted) ? accepted : null,
        error?.code || null, error?.message?.slice(0, 1000) || null, now, id).run();
  }

  async runs(limit = 50): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.database.prepare('SELECT * FROM sync_runs ORDER BY created_at DESC LIMIT ?').bind(limit).all<Record<string, unknown>>()).results;
    return rows.map((row) => ({ ...row, target: json(String(row.target_json || ''), {}), progress: json(String(row.progress_json || ''), {}), target_json: undefined, progress_json: undefined }));
  }

  async syncHistory(limit = 100, countryCode = '', offset = 0): Promise<Record<string, unknown>> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit || 100)));
    const boundedOffset = Math.max(0, Math.trunc(offset || 0));
    const country = countryCode.trim().toUpperCase();
    const rows = (await this.database.prepare(`SELECT run.id,run.kind,run.status AS run_status,run.target_json,
      run.progress_json,run.error_code AS run_error_code,run.error_message AS run_error_message,
      run.failure_phase AS run_failure_phase,
      run.created_at AS run_created_at,run.started_at AS run_started_at,run.completed_at AS run_completed_at,
      country.country_code,country.source_id,country.trigger_name,country.status,country.started_at,country.completed_at,
      country.heartbeat_at,country.deadline_at,country.before_count,country.after_count,country.net_growth,
      country.candidate_count,country.accepted_count,country.rejected_count,country.rejection_reasons_json,country.metrics_json,
      country.before_goals_json,country.after_goals_json,country.error_code,country.error_message,country.failure_phase
      FROM sync_runs run LEFT JOIN sync_run_countries country ON country.run_id=run.id
      WHERE (?='' OR country.country_code=?) ORDER BY run.created_at DESC,country.country_code,country.source_id LIMIT ? OFFSET ?`)
      .bind(country, country, boundedLimit + 1, boundedOffset).all<Record<string, unknown>>()).results;
    const hasMore = rows.length > boundedLimit;
    const pageRows = rows.slice(0, boundedLimit);
    const scheduler = await this.database.prepare(`SELECT scheduler_id,heartbeat_at,last_planned_at,active_run_id,updated_at
      FROM sync_scheduler_state WHERE scheduler_id='address-sync'`).first<Record<string, unknown>>();
    const countries = (await this.database.prepare(`SELECT DISTINCT country_code FROM sync_run_countries
      WHERE country_code<>'' ORDER BY country_code`).all<{ country_code: string }>()).results.map((row) => row.country_code);
    return {
      scheduler: scheduler || null,
      countries,
      limit: boundedLimit,
      offset: boundedOffset,
      hasMore,
      nextOffset: hasMore ? boundedOffset + boundedLimit : null,
      items: pageRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        countryCode: row.country_code || (String(row.kind || '').startsWith('china') ? 'CN' : null),
        sourceId: row.source_id || '',
        trigger: row.trigger_name || json<Record<string, unknown>>(String(row.target_json || ''), {}).trigger || 'automatic',
        status: row.status || row.run_status,
        createdAt: row.run_created_at,
        startedAt: row.started_at || row.run_started_at,
        completedAt: row.completed_at || row.run_completed_at,
        heartbeatAt: row.heartbeat_at || null,
        deadlineAt: row.deadline_at || null,
        beforeCount: row.before_count === null || row.before_count === undefined ? null : Number(row.before_count),
        afterCount: row.after_count === null || row.after_count === undefined ? null : Number(row.after_count),
        netGrowth: row.net_growth === null || row.net_growth === undefined ? null : Number(row.net_growth),
        candidateCount: row.candidate_count === null || row.candidate_count === undefined ? null : Number(row.candidate_count),
        acceptedCount: row.accepted_count === null || row.accepted_count === undefined ? null : Number(row.accepted_count),
        rejectedCount: row.rejected_count === null || row.rejected_count === undefined ? null : Number(row.rejected_count),
        rejectionReasons: json(String(row.rejection_reasons_json || ''), {}),
        metrics: json(String(row.metrics_json || ''), {}),
        beforeGoals: syncGoalSnapshot(json(String(row.before_goals_json || ''), null)),
        afterGoals: syncGoalSnapshot(json(String(row.after_goals_json || ''), null)),
        errorCode: row.country_code ? row.error_code || null : row.run_error_code || null,
        errorMessage: row.country_code ? row.error_message || null : row.run_error_message || null,
        failurePhase: row.country_code ? row.failure_phase || null : row.run_failure_phase || null
      }))
    };
  }
}

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number, error: string): number => {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(error);
  return number;
};

export type ServiceCredentialResolver = (provider: ServiceProviderName) => Promise<string | undefined>;

const serviceEnvironmentSecret = (provider: ServiceProviderName, environment: Record<string, string | undefined>): string | undefined => {
  if (provider === 'youdao') {
    const appKey = environment.YOUDAO_APP_KEY?.trim();
    const appSecret = environment.YOUDAO_APP_SECRET?.trim();
    return appKey && appSecret ? JSON.stringify({ appKey, appSecret }) : undefined;
  }
  const names: Record<Exclude<ServiceProviderName, 'youdao'>, string> = {
    geoapify: 'GEOAPIFY_API_KEY', 'google-geocoding': 'GOOGLE_GEOCODING_API_KEY', mappls: 'MAPPLS_API_KEY'
  };
  return environment[names[provider]]?.trim() || undefined;
};

export const createServiceCredentialResolver = (
  store: ControlStore,
  environment: Record<string, string | undefined>,
  cacheMs = 60_000
): ServiceCredentialResolver => {
  const cache = new Map<ServiceProviderName, { value: string | undefined; expiresAt: number }>();
  return async (provider) => {
    const cached = cache.get(provider);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const stored = await store.acquireCredential(provider).catch(() => null);
    const value = stored?.secret ?? serviceEnvironmentSecret(provider, environment);
    cache.set(provider, { value, expiresAt: Date.now() + cacheMs });
    return value;
  };
};
