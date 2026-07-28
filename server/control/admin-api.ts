import { stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SqliteDatabase } from '../database/sqlite.mjs';
import type { ChinaDataService } from '../china/service';
import { providerFetcher, ProviderRequestError } from '../china/providers';
import { safeEqual } from './security';
import type { BrowserMapCredentialInput, BrowserMapCredentialUpdate, ControlStore, CredentialInput, CredentialProviderName, MapDisplayConfig, ProviderName, ProviderQuotaObservation } from './store';
import { listAddressCoverage } from './coverage';
import { nonResidentialRules } from '../../src/domain/non-residential-rules.mjs';
import { customBlacklistKeywords, replaceCustomBlacklist } from '../lib/custom-blacklist.mjs';
import {
  deleteNodePolicy, getRuntimePolicy, listCountryPolicies, listNodePolicies,
  updateCountryPolicy, updateRuntimePolicy, upsertNodePolicy
} from '../sync/address-policy.mjs';

const adminCookie = 'address_admin_session';
const adminCsrfCookie = 'address_admin_csrf';
const frontCookie = 'address_front_session';
const secureCookie = { httpOnly: true, secure: process.env.COOKIE_SECURE !== 'false', sameSite: 'Strict' as const, path: '/' };
const csrfCookie = { ...secureCookie, httpOnly: false };
const bearer = (value: string | undefined): string => value?.startsWith('Bearer ') ? value.slice(7).trim() : '';
type RequestBindings = { remoteAddress?: string };

export const requestClientAddress = (request: Request, remoteAddress = '', trustProxy = false): string => {
  const realIp = trustProxy ? request.headers.get('x-real-ip')?.trim() : '';
  const forwarded = trustProxy ? request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() : '';
  return (realIp || forwarded || remoteAddress.trim() || 'local').slice(0, 64);
};

export const createAmapProxyRateLimiter = (limit = 1200, windowMs = 60_000) => {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (client: string, now = Date.now()): boolean => {
    const current = buckets.get(client);
    if (!current || current.resetAt <= now) {
      if (buckets.size > 5000) {
        for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
      }
      if (buckets.size >= 10_000 && !buckets.has(client)) return false;
      buckets.set(client, { count: 1, resetAt: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
};

export const testOneMapCredential = async (token: string, fetcher: typeof fetch = fetch) => {
  const url = new URL('https://www.onemap.gov.sg/api/common/elastic/search');
  Object.entries({ searchVal: '1 Raffles Place', returnGeom: 'Y', getAddrDetails: 'Y', pageNum: '1' })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new ProviderRequestError('network', 'NETWORK_ERROR');
  }
  if (response.status === 429) throw new ProviderRequestError('qps', 'RATE_LIMITED');
  if (!response.ok) {
    throw new ProviderRequestError(response.status === 401 || response.status === 403 ? 'auth' : 'network', `HTTP_${response.status}`);
  }
  let body: { found?: number; totalNumPages?: number; results?: unknown[] };
  try { body = await response.json() as typeof body; }
  catch { throw new ProviderRequestError('invalid', 'INVALID_JSON'); }
  if (!Array.isArray(body.results)) throw new ProviderRequestError('invalid', 'INVALID_RESPONSE');
  return {
    success: true,
    resultCount: body.results.length,
    totalResults: Number(body.found || 0),
    totalPages: Number(body.totalNumPages || 0)
  };
};

const isMapProvider = (provider: CredentialProviderName): provider is ProviderName =>
  provider === 'amap' || provider === 'baidu' || provider === 'tencent';

const amapServicePrefix = '/_AMapService';
const allowedAmapResponseTypes = new Set([
  'application/json', 'application/javascript', 'application/xml',
  'text/javascript', 'text/plain', 'text/xml'
]);
const allowedAmapVectorTypes = new Set([
  'application/octet-stream', 'application/protobuf', 'application/x-protobuf',
  'application/vnd.mapbox-vector-tile', 'image/jpeg', 'image/png', 'image/webp'
]);
const sameOrigin = (value: string | null, expectedOrigin: string): boolean => {
  if (!value) return true;
  try { return new URL(value).origin === expectedOrigin; } catch { return false; }
};
const proxyError = (status: number, error: string): Response => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

export const proxyAmapServiceRequest = async (
  control: ControlStore,
  request: Request,
  fetcher: typeof fetch = fetch,
  allowedOrigin?: string
): Promise<Response> => {
  if (request.method !== 'GET') return proxyError(405, 'METHOD_NOT_ALLOWED');
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  let expectedOrigin = requestUrl.origin;
  if (allowedOrigin?.trim() && allowedOrigin.trim() !== '*') {
    try {
      const configured = new URL(allowedOrigin.trim());
      if (!['http:', 'https:'].includes(configured.protocol)) return proxyError(403, 'FORBIDDEN');
      expectedOrigin = configured.origin;
    }
    catch { return proxyError(403, 'FORBIDDEN'); }
  }
  if ((!origin && !referer) || !sameOrigin(origin, expectedOrigin) || !sameOrigin(referer, expectedOrigin)) {
    return proxyError(403, 'FORBIDDEN');
  }
  const config = await control.mapDisplayConfig();
  if (!config.amap.china && !config.amap.international) return proxyError(404, 'NOT_FOUND');
  const credential = await control.acquireBrowserMapCredential();
  if (!credential) return proxyError(404, 'NOT_FOUND');
  const path = requestUrl.pathname.slice(amapServicePrefix.length);
  if (!path.startsWith('/') || /%(?:2e|2f|5c)/iu.test(path)) return proxyError(400, 'INVALID_AMAP_SERVICE_PATH');
  const customStyle = /^\/v4\/map\/styles(?:\/|$)/u.test(path);
  const vectorMap = path === '/v3/vectormap';
  if (!vectorMap && /^\/v3\/vectormap(?:\/|$)/u.test(path)) return proxyError(404, 'NOT_FOUND');
  if (!customStyle && !/^\/(?:v3|v4|v5|ws)\//u.test(path)) return proxyError(404, 'NOT_FOUND');
  const suppliedKey = requestUrl.searchParams.get('key') || '';
  if (!suppliedKey || !safeEqual(suppliedKey, credential.apiKey)) return proxyError(403, 'FORBIDDEN');
  const upstream = new URL(path, customStyle
    ? 'https://webapi.amap.com'
    : vectorMap ? 'https://fmap01.amap.com' : 'https://restapi.amap.com');
  requestUrl.searchParams.forEach((value, name) => {
    if (name !== 'jscode' && name !== 'key') upstream.searchParams.append(name, value);
  });
  upstream.searchParams.set('key', credential.apiKey);
  upstream.searchParams.set('jscode', credential.securityCode);
  try {
    const response = await fetcher(upstream, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json,text/javascript,*/*;q=0.8' }
    });
    const contentType = response.headers.get('content-type') || 'application/json';
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    const textResponse = allowedAmapResponseTypes.has(mediaType);
    if (!textResponse && !(vectorMap && allowedAmapVectorTypes.has(mediaType))) {
      return proxyError(502, 'INVALID_AMAP_SERVICE_RESPONSE');
    }
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'Content-Type': contentType,
      Expires: '0',
      Pragma: 'no-cache'
    });
    const body = textResponse
      ? (await response.text()).split(credential.securityCode).join('')
      : await response.arrayBuffer();
    return new Response(body, { status: response.status, headers });
  } catch {
    return proxyError(502, 'AMAP_SERVICE_UNAVAILABLE');
  }
};

export const createAdminApi = ({
  control, china, addressDb, addressDatabasePath, controlDatabasePath, trustProxy = false
}: {
  control: ControlStore; china: ChinaDataService; addressDb: SqliteDatabase; addressDatabasePath: string; controlDatabasePath: string; trustProxy?: boolean;
}) => {
  const app = new Hono<{ Bindings: RequestBindings }>();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const coverageMaxAgeMs = 5 * 60_000;
  let coverageRefresh: Promise<void> | undefined;
  const startCoverageRefresh = (): Promise<void> => {
    coverageRefresh ||= new Promise<void>((resolveRefresh, rejectRefresh) => {
      const worker = new Worker(new URL('./coverage-worker.ts', import.meta.url), {
        execArgv: ['--import', 'tsx'], workerData: { databasePath: addressDatabasePath }
      });
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) rejectRefresh(error);
        else resolveRefresh();
      };
      worker.once('message', () => settle());
      worker.once('error', (error) => settle(error instanceof Error ? error : new Error(String(error))));
      worker.once('exit', (code) => {
        if (code !== 0) settle(new Error(`COVERAGE_REFRESH_WORKER_EXIT_${code}`));
      });
    }).finally(() => { coverageRefresh = undefined; });
    return coverageRefresh;
  };
  const ensureCoverage = async (force = false): Promise<void> => {
    const snapshot = await addressDb.prepare(`SELECT COUNT(*) AS total,MAX(updated_at) AS updated_at
      FROM admin_coverage_stats`).first<{ total: number; updated_at: string | null }>();
    if (!Number(snapshot?.total || 0)) {
      await startCoverageRefresh();
      return;
    }
    if (force) await startCoverageRefresh();
    else {
      const updatedAt = Date.parse(snapshot?.updated_at || '');
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt >= coverageMaxAgeMs) {
        void startCoverageRefresh().catch(() => undefined);
      }
    }
  };

  app.onError((error, context) => {
    context.header('Cache-Control', 'no-store');
    const code = error.message || 'INTERNAL_ERROR';
    const clientError = /^(?:INVALID_|PASSWORD_LENGTH|PASSWORD_CONFIRM_MISMATCH|FRONTEND_PASSWORD_REQUIRED|TOKEN_NAME_REQUIRED|TOKEN_ALREADY_EXISTS|API_TOKEN_|AREACITY_SOURCE_|AREACITY_DATA_|SOURCE_AND_VERSION_REQUIRED|POLICY_)/u.test(code);
    const status = ['CHINA_SYNC_BUSY', 'NO_AVAILABLE_KEY', 'BROWSER_MAP_CREDENTIAL_EXISTS', 'TOKEN_ALREADY_EXISTS'].includes(code) ? 409
      : ['CREDENTIAL_NOT_FOUND', 'BROWSER_MAP_CREDENTIAL_NOT_FOUND', 'API_TOKEN_NOT_FOUND'].includes(code) ? 404
        : ['API_TOKEN_SECRET_UNAVAILABLE'].includes(code) ? 409 : clientError ? 400 : 500;
    return context.json({ error: status < 500 ? code : 'INTERNAL_ERROR' }, status);
  });
  app.use('/admin/api/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    const publicRoute = ['/admin/api/status', '/admin/api/login', '/admin/api/session'].includes(context.req.path);
    if (!publicRoute) {
      const token = getCookie(context, adminCookie) || '';
      const csrf = context.req.method === 'GET' ? undefined : context.req.header('x-csrf-token') || '';
      if (!await control.session(token, 'admin', csrf)) return context.json({ error: 'UNAUTHORIZED' }, 401);
    }
    await next();
  });

  app.get('/admin/api/status', async (context) => context.json({ data: await control.status() }));
  app.post('/admin/api/login', async (context) => {
    const ip = requestClientAddress(context.req.raw, context.env?.remoteAddress, trustProxy);
    if (loginAttempts.size > 5000) loginAttempts.clear();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.resetAt > Date.now() && attempt.count >= 8) return context.json({ error: 'LOGIN_RATE_LIMITED' }, 429);
    const input = await context.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    if (!await control.verifyIdentity('admin', String(input.password || ''))) {
      loginAttempts.set(ip, { count: attempt?.resetAt && attempt.resetAt > Date.now() ? attempt.count + 1 : 1, resetAt: Date.now() + 15 * 60000 });
      return context.json({ error: 'INVALID_CREDENTIALS' }, 401);
    }
    loginAttempts.delete(ip);
    const session = await control.createSession('admin', ip);
    setCookie(context, adminCookie, session.token, { ...secureCookie, maxAge: 12 * 60 * 60 });
    setCookie(context, adminCsrfCookie, session.csrf, { ...csrfCookie, maxAge: 12 * 60 * 60 });
    await control.audit('admin', 'session.login', 'admin');
    return context.json({ data: { csrfToken: session.csrf, expiresAt: session.expiresAt } });
  });
  app.post('/admin/api/logout', async (context) => {
    await control.deleteSession(getCookie(context, adminCookie) || '');
    deleteCookie(context, adminCookie, { path: '/' });
    deleteCookie(context, adminCsrfCookie, { path: '/' });
    return context.json({ data: { success: true } });
  });
  app.get('/admin/api/session', async (context) => {
    const token = getCookie(context, adminCookie) || '';
    let csrf = getCookie(context, adminCsrfCookie) || '';
    if (!csrf || !await control.session(token, 'admin', csrf)) csrf = await control.refreshSessionCsrf(token, 'admin') || '';
    if (!csrf) return context.json({ data: { authenticated: false } });
    setCookie(context, adminCsrfCookie, csrf, { ...csrfCookie, maxAge: 12 * 60 * 60 });
    return context.json({ data: { authenticated: true } });
  });

  app.get('/admin/api/dashboard', async (context) => {
    const [addressCount, chinaStatus, credentials, runs] = await Promise.all([
      addressDb.prepare('SELECT COUNT(*) AS total FROM address_pool WHERE active=1').first<number>('total'),
      china.status(), control.listCredentials(), control.runs(10)
    ]);
    const size = async (path: string) => { try { return (await stat(path)).size; } catch { return 0; } };
    return context.json({ data: {
      addressCount: Number(addressCount || 0), china: chinaStatus, credentials, runs,
      storage: { addressBytes: await size(addressDatabasePath), controlBytes: await size(controlDatabasePath) }
    } });
  });
  app.get('/admin/api/dashboard/coverage', async (context) => {
    const parent = String(context.req.query('parent') || '');
    if (parent.length > 512) return context.json({ error: 'INVALID_COVERAGE_PARENT' }, 400);
    await ensureCoverage(context.req.query('refresh') === 'true');
    return context.json({ data: await listAddressCoverage(addressDb, parent) });
  });

  app.get('/admin/api/sync/policies', async (context) => {
    await ensureCoverage();
    const [runtime, countries] = await Promise.all([getRuntimePolicy(addressDb), listCountryPolicies(addressDb)]);
    return context.json({ data: { runtime, countries } });
  });
  app.put('/admin/api/sync/policies/runtime', async (context) => {
    const value = await updateRuntimePolicy(addressDb, await context.req.json<Record<string, unknown>>());
    await control.audit('admin', 'sync_policy.runtime.update', 'global', {
      prepareConcurrency: value.prepareConcurrency, cpuConcurrency: value.cpuConcurrency
    });
    return context.json({ data: value });
  });
  app.put('/admin/api/sync/policies/countries/:country', async (context) => {
    const countryCode = context.req.param('country').toUpperCase();
    const value = await updateCountryPolicy(addressDb, countryCode, await context.req.json<Record<string, unknown>>());
    await control.audit('admin', 'sync_policy.country.update', countryCode, value);
    return context.json({ data: value });
  });
  app.get('/admin/api/sync/policies/nodes', async (context) => {
    const parent = String(context.req.query('parent') || '');
    if (parent.length > 512) return context.json({ error: 'INVALID_POLICY_PARENT' }, 400);
    await ensureCoverage();
    return context.json({ data: await listNodePolicies(addressDb, parent) });
  });
  app.put('/admin/api/sync/policies/nodes', async (context) => {
    const input = await context.req.json<{ key?: string; targetCount?: number }>();
    if (!input.key || input.key.length > 512) return context.json({ error: 'INVALID_POLICY_NODE' }, 400);
    const value = await upsertNodePolicy(addressDb, input.key, input.targetCount);
    await control.audit('admin', 'sync_policy.node.update', input.key, { targetCount: input.targetCount });
    return context.json({ data: value });
  });
  app.delete('/admin/api/sync/policies/nodes', async (context) => {
    const key = String(context.req.query('key') || '');
    if (!key || key.length > 512) return context.json({ error: 'INVALID_POLICY_NODE' }, 400);
    await deleteNodePolicy(addressDb, key);
    await control.audit('admin', 'sync_policy.node.delete', key);
    return context.json({ data: { success: true } });
  });

  app.get('/admin/api/settings/access', async (context) => context.json({ data: await control.status() }));
  app.get('/admin/api/settings/blacklist', (context) => context.json({ data: {
    keywords: customBlacklistKeywords(),
    builtIn: Object.entries(nonResidentialRules).map(([category, rule]) => ({
      category,
      terms: [...new Set([...(rule.terms.zh || []), ...(rule.terms.en || [])])]
    }))
  } }));
  app.put('/admin/api/settings/blacklist', async (context) => {
    const input = await context.req.json<{ keywords?: unknown[] }>();
    const keywords = replaceCustomBlacklist(input.keywords ?? []);
    await control.audit('admin', 'settings.blacklist.update', 'address-filter', { keywordCount: keywords.length });
    return context.json({ data: { keywords } });
  });
  app.put('/admin/api/settings/access', async (context) => {
    const input = await context.req.json<{
      frontendPasswordEnabled?: boolean; frontendPassword?: string; frontendPasswordConfirmation?: string;
      apiAuthEnabled?: boolean; adminPassword?: string; adminPasswordConfirmation?: string;
    }>();
    await control.updateAccessSettings(input, getCookie(context, adminCookie) || '');
    return context.json({ data: await control.status() });
  });

  app.get('/admin/api/settings/maps', async (context) => context.json({ data: {
    ...await control.mapDisplayConfig(),
    amapBrowser: await control.browserMapCredentialStatus()
  } }));
  app.put('/admin/api/settings/maps', async (context) => {
    const input = await context.req.json<MapDisplayConfig>();
    const value = await control.updateMapDisplayConfig(input);
    await control.audit('admin', 'settings.maps.update', 'maps', { google: value.google, amap: value.amap });
    return context.json({ data: { ...value, amapBrowser: await control.browserMapCredentialStatus() } });
  });
  app.post('/admin/api/maps/amap-browser', async (context) => {
    const input = await context.req.json<BrowserMapCredentialInput>();
    await control.createBrowserMapCredential(input);
    const status = await control.browserMapCredentialStatus();
    await control.audit('admin', 'browser_map_credential.create', 'amap', { enabled: status.enabled });
    return context.json({ data: status }, 201);
  });
  app.put('/admin/api/maps/amap-browser', async (context) => {
    const input = await context.req.json<BrowserMapCredentialUpdate>();
    await control.updateBrowserMapCredential(input);
    await control.audit('admin', 'browser_map_credential.update', 'amap', {
      labelChanged: Boolean(input.label?.trim()), apiKeyChanged: Boolean(input.apiKey?.trim()),
      securityCodeChanged: Boolean(input.securityCode?.trim()), enabled: input.enabled
    });
    return context.json({ data: await control.browserMapCredentialStatus() });
  });
  app.delete('/admin/api/maps/amap-browser', async (context) => {
    await control.deleteBrowserMapCredential();
    await control.audit('admin', 'browser_map_credential.delete', 'amap');
    return context.json({ data: await control.browserMapCredentialStatus() });
  });
  app.post('/admin/api/maps/amap-browser/reveal', async (context) => {
    return context.json({ data: await control.revealBrowserMapCredential() });
  });

  app.get('/admin/api/tokens', async (context) => context.json({ data: await control.listApiTokens() }));
  app.post('/admin/api/tokens', async (context) => {
    const input = await context.req.json<{ name?: string; token?: string; scopes?: string[]; rateLimit?: number; expiresAt?: string | null }>();
    if (!input.name?.trim()) return context.json({ error: 'TOKEN_NAME_REQUIRED' }, 400);
    const rateLimit = Number(input.rateLimit ?? 60);
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000) return context.json({ error: 'INVALID_TOKEN_RATE_LIMIT' }, 400);
    const created = await control.createApiToken({ name: input.name, token: input.token, scopes: input.scopes, rateLimit, expiresAt: input.expiresAt });
    await control.audit('admin', 'api_token.create', created.id, { name: input.name, scopes: input.scopes || ['*'], hasCustomToken: Boolean(input.token?.trim()) });
    return context.json({ data: created }, 201);
  });
  app.put('/admin/api/tokens/:id', async (context) => {
    const input = await context.req.json<{ scopes?: string[]; rateLimit?: number; expiresAt?: string | null }>();
    await control.updateApiToken(context.req.param('id'), input);
    await control.audit('admin', 'api_token.update', context.req.param('id'), {
      scopesChanged: input.scopes !== undefined, rateLimitChanged: input.rateLimit !== undefined, expiresAtChanged: Object.hasOwn(input, 'expiresAt')
    });
    return context.json({ data: await control.listApiTokens() });
  });
  app.post('/admin/api/tokens/:id/reveal', async (context) => {
    return context.json({ data: await control.revealApiToken(context.req.param('id')) });
  });
  app.delete('/admin/api/tokens/:id', async (context) => {
    await control.revokeApiToken(context.req.param('id'));
    await control.audit('admin', 'api_token.revoke', context.req.param('id'));
    return context.json({ data: { success: true } });
  });

  app.get('/admin/api/providers', async (context) => context.json({ data: await control.listCredentials() }));
  app.post('/admin/api/providers', async (context) => {
    const input = await context.req.json<CredentialInput>();
    const id = await control.addCredential(input);
    await control.audit('admin', 'provider_key.create', id, { provider: input.provider });
    return context.json({ data: { id } }, 201);
  });
  app.put('/admin/api/providers/:id', async (context) => {
    await control.updateCredential(context.req.param('id'), await context.req.json<Record<string, unknown>>());
    await control.audit('admin', 'provider_key.update', context.req.param('id'));
    return context.json({ data: { success: true } });
  });
  app.delete('/admin/api/providers/:id', async (context) => {
    await control.deleteCredential(context.req.param('id'));
    await control.audit('admin', 'provider_key.delete', context.req.param('id'));
    return context.json({ data: { success: true } });
  });
  app.post('/admin/api/providers/:id/reveal', async (context) => {
    return context.json({ data: await control.revealCredential(context.req.param('id')) });
  });
  app.post('/admin/api/providers/:credential/test', async (context) => {
    const value = context.req.param('credential');
    const provider = value as CredentialProviderName;
    const credential = ['amap', 'baidu', 'tencent', 'onemap'].includes(provider)
      ? await control.acquireCredential(provider)
      : await control.acquireCredentialById(value);
    if (!credential) return context.json({ error: 'NO_AVAILABLE_KEY' }, 409);
    try {
      let resolved: { success: boolean; resultCount: number; quota?: ProviderQuotaObservation };
      if (credential.provider === 'onemap') resolved = await testOneMapCredential(credential.secret);
      else if (isMapProvider(credential.provider)) {
        let quota: ProviderQuotaObservation | undefined;
        const result = await providerFetcher[credential.provider]('北京市', 1, credential.secret, fetch, (value) => { quota = value; });
        resolved = { success: true, resultCount: result.candidates.length, quota };
      } else resolved = { success: false, resultCount: 0 };
      await control.reportCredential(credential.id, 'success', 'quota' in resolved ? resolved.quota : undefined);
      return context.json({ data: resolved });
    } catch (error) {
      const outcome = error instanceof ProviderRequestError ? error.outcome : 'network';
      await control.reportCredential(credential.id, outcome);
      return context.json({ error: 'PROVIDER_TEST_FAILED', outcome }, 502);
    }
  });

  app.get('/admin/api/china/status', async (context) => context.json({ data: await china.status() }));
  app.post('/admin/api/china/sync', async (context) => {
    const input = await context.req.json<{ cities?: string[]; providers?: ProviderName[]; maxPages?: number }>().catch(() => ({}));
    const id = await china.start(input);
    await control.audit('admin', 'china.sync.start', id, input);
    return context.json({ data: { id } }, 202);
  });
  app.post('/admin/api/china/areacity', async (context) => {
    const input = await context.req.json<{ source?: string; version?: string }>();
    if (!input.source || !input.version) return context.json({ error: 'SOURCE_AND_VERSION_REQUIRED' }, 400);
    if (input.source.length > 2048 || input.version.length > 80) return context.json({ error: 'INVALID_AREACITY_INPUT' }, 400);
    const count = await china.importAreaCity(input.source.trim(), input.version.trim());
    return context.json({ data: { count } });
  });
  app.get('/admin/api/china/quality', async (context) => {
    const rows = (await addressDb.prepare(`SELECT city,district,COUNT(*) AS total,
      SUM(CASE WHEN source_count>=2 THEN 1 ELSE 0 END) AS cross_verified
      FROM cn_communities_v2 WHERE active=1 GROUP BY city,district ORDER BY city,district`).all()).results;
    return context.json({ data: rows });
  });
  app.get('/admin/api/runs', async (context) => context.json({ data: await control.runs(100) }));
  return app;
};

export const createAccessApi = (control: ControlStore, { trustProxy = false }: { trustProxy?: boolean } = {}) => {
  const app = new Hono<{ Bindings: RequestBindings }>();
  const attempts = new Map<string, { count: number; resetAt: number }>();
  app.get('/web-api/v1/config/maps', async (context) => {
    if (!await authorizeWebRequest(control, context.req.raw)) {
      return context.json({ error: 'FRONTEND_AUTH_REQUIRED' }, 401, { 'Cache-Control': 'no-store' });
    }
    const countryCode = String(context.req.query('country') || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/u.test(countryCode)) return context.json({ error: 'INVALID_COUNTRY' }, 400);
    const config = await control.mapDisplayConfig();
    const china = countryCode === 'CN';
    const googleEnabled = china ? config.google.china : config.google.international;
    const amapRequested = china ? config.amap.china : config.amap.international;
    const amapStatus = await control.browserMapCredentialStatus();
    const credential = amapRequested && amapStatus.enabled ? await control.acquireBrowserMapCredential() : null;
    context.header('Cache-Control', 'no-store');
    return context.json({ data: {
      countryCode,
      googleEnabled,
      amapEnabled: Boolean(credential),
      amapConfigured: amapStatus.configured,
      ...(credential ? { amapApiKey: credential.apiKey, serviceHost: amapServicePrefix } : {})
    } });
  });
  app.get('/web-api/v1/auth/status', async (context) => {
    const status = await control.status();
    const authenticated = !status.frontendPasswordEnabled || await control.session(getCookie(context, frontCookie) || '', 'frontend');
    return context.json({ data: { enabled: status.frontendPasswordEnabled, authenticated } });
  });
  app.post('/web-api/v1/auth/login', async (context) => {
    const status = await control.status();
    if (!status.frontendPasswordEnabled) return context.json({ data: { authenticated: true } });
    const ip = requestClientAddress(context.req.raw, context.env?.remoteAddress, trustProxy);
    if (attempts.size > 5000) attempts.clear();
    const attempt = attempts.get(ip);
    if (attempt && attempt.resetAt > Date.now() && attempt.count >= 12) return context.json({ error: 'LOGIN_RATE_LIMITED' }, 429);
    const input = await context.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    if (!await control.verifyIdentity('frontend', String(input.password || ''))) {
      attempts.set(ip, { count: attempt?.resetAt && attempt.resetAt > Date.now() ? attempt.count + 1 : 1, resetAt: Date.now() + 15 * 60000 });
      return context.json({ error: 'INVALID_CREDENTIALS' }, 401);
    }
    attempts.delete(ip);
    const session = await control.createSession('frontend');
    setCookie(context, frontCookie, session.token, { ...secureCookie, maxAge: 24 * 60 * 60 });
    return context.json({ data: { authenticated: true } });
  });
  app.post('/web-api/v1/auth/logout', async (context) => {
    await control.deleteSession(getCookie(context, frontCookie) || '');
    deleteCookie(context, frontCookie, { path: '/' });
    return context.json({ data: { success: true } });
  });
  return app;
};

export const authorizeWebRequest = async (control: ControlStore, request: Request): Promise<boolean> => {
  if (!await control.setting('frontend_password_enabled', false)) return true;
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)address_front_session=([^;]+)/u);
  if (!match) return false;
  try { return control.session(decodeURIComponent(match[1]), 'frontend'); }
  catch { return false; }
};

export const authorizeApiRequest = async (control: ControlStore, request: Request): Promise<boolean> => {
  const value = bearer(request.headers.get('authorization') || undefined);
  return (await control.authorizeApiTokenDetailed(value, request.url.includes('/generate') ? 'generate' : 'read')).status === 'authorized';
};

export const apiAuthorization = async (control: ControlStore, request: Request) => {
  const value = bearer(request.headers.get('authorization') || undefined);
  return control.authorizeApiTokenDetailed(value, request.url.includes('/generate') ? 'generate' : 'read');
};
