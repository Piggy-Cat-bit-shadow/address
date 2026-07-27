import { stat } from 'node:fs/promises';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SqliteDatabase } from '../database/sqlite.mjs';
import type { ChinaDataService } from '../china/service';
import { providerFetcher, ProviderRequestError } from '../china/providers';
import type { ControlStore, ProviderName } from './store';

const adminCookie = 'address_admin_session';
const frontCookie = 'address_front_session';
const secureCookie = { httpOnly: true, secure: process.env.COOKIE_SECURE !== 'false', sameSite: 'Strict' as const, path: '/' };
const bearer = (value: string | undefined): string => value?.startsWith('Bearer ') ? value.slice(7).trim() : '';

export const createAdminApi = ({
  control, china, addressDb, addressDatabasePath, controlDatabasePath
}: {
  control: ControlStore; china: ChinaDataService; addressDb: SqliteDatabase; addressDatabasePath: string; controlDatabasePath: string;
}) => {
  const app = new Hono();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  app.onError((error, context) => {
    const code = error.message || 'INTERNAL_ERROR';
    const clientError = /^(?:INVALID_|PASSWORD_LENGTH|AREACITY_SOURCE_|AREACITY_DATA_|SOURCE_AND_VERSION_REQUIRED)/u.test(code);
    const status = code === 'CHINA_SYNC_BUSY' ? 409 : code === 'CREDENTIAL_NOT_FOUND' ? 404 : clientError ? 400 : 500;
    return context.json({ error: status < 500 ? code : 'INTERNAL_ERROR' }, status);
  });
  app.use('/admin/api/*', async (context, next) => {
    const publicRoute = ['/admin/api/status', '/admin/api/login'].includes(context.req.path);
    if (publicRoute) return next();
    const token = getCookie(context, adminCookie) || '';
    const csrf = context.req.method === 'GET' ? undefined : context.req.header('x-csrf-token') || '';
    if (!await control.session(token, 'admin', csrf)) return context.json({ error: 'UNAUTHORIZED' }, 401);
    await next();
  });

  app.get('/admin/api/status', async (context) => context.json({ data: await control.status() }));
  app.post('/admin/api/login', async (context) => {
    const ip = context.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
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
    await control.audit('admin', 'session.login', 'admin');
    return context.json({ data: { csrfToken: session.csrf, expiresAt: session.expiresAt } });
  });
  app.post('/admin/api/logout', async (context) => {
    await control.deleteSession(getCookie(context, adminCookie) || '');
    deleteCookie(context, adminCookie, { path: '/' });
    return context.json({ data: { success: true } });
  });
  app.get('/admin/api/session', async (context) => context.json({ data: { authenticated: true } }));

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

  app.get('/admin/api/settings/access', async (context) => context.json({ data: await control.status() }));
  app.put('/admin/api/settings/access', async (context) => {
    const input = await context.req.json<{ frontendPasswordEnabled?: boolean; frontendPassword?: string; apiAuthEnabled?: boolean; adminPassword?: string }>();
    if (input.frontendPassword) await control.setPassword('frontend', input.frontendPassword);
    if (input.adminPassword) await control.setPassword('admin', input.adminPassword, getCookie(context, adminCookie) || '');
    if (input.frontendPasswordEnabled && !input.frontendPassword && !await control.hasIdentity('frontend')) {
      return context.json({ error: 'FRONTEND_PASSWORD_REQUIRED' }, 400);
    }
    if (input.frontendPasswordEnabled !== undefined) await control.setSetting('frontend_password_enabled', Boolean(input.frontendPasswordEnabled));
    if (input.apiAuthEnabled !== undefined) await control.setSetting('api_auth_enabled', input.apiAuthEnabled);
    await control.audit('admin', 'settings.access.update', 'access', {
      frontendPasswordEnabled: input.frontendPasswordEnabled, apiAuthEnabled: input.apiAuthEnabled,
      frontendPasswordChanged: Boolean(input.frontendPassword), adminPasswordChanged: Boolean(input.adminPassword)
    });
    return context.json({ data: await control.status() });
  });

  app.get('/admin/api/tokens', async (context) => context.json({ data: await control.listApiTokens() }));
  app.post('/admin/api/tokens', async (context) => {
    const input = await context.req.json<{ name?: string; scopes?: string[]; rateLimit?: number; expiresAt?: string | null }>();
    if (!input.name?.trim()) return context.json({ error: 'TOKEN_NAME_REQUIRED' }, 400);
    const rateLimit = Number(input.rateLimit ?? 60);
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000) return context.json({ error: 'INVALID_TOKEN_RATE_LIMIT' }, 400);
    const created = await control.createApiToken({ name: input.name, scopes: input.scopes || ['generate'], rateLimit, expiresAt: input.expiresAt });
    await control.audit('admin', 'api_token.create', created.id, { name: input.name, scopes: input.scopes || ['generate'] });
    return context.json({ data: created }, 201);
  });
  app.delete('/admin/api/tokens/:id', async (context) => {
    await control.revokeApiToken(context.req.param('id'));
    await control.audit('admin', 'api_token.revoke', context.req.param('id'));
    return context.json({ data: { success: true } });
  });

  app.get('/admin/api/providers', async (context) => context.json({ data: await control.listCredentials() }));
  app.post('/admin/api/providers', async (context) => {
    const input = await context.req.json<{ provider: ProviderName; label: string; secret: string; weight?: number; qpsLimit?: number; dailyLimit?: number; quotaScopeId?: string }>();
    const id = await control.addCredential(input);
    await control.audit('admin', 'provider_key.create', id, { provider: input.provider, label: input.label });
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
  app.post('/admin/api/providers/:provider/test', async (context) => {
    const provider = context.req.param('provider') as ProviderName;
    if (!['amap', 'baidu', 'tencent'].includes(provider)) return context.json({ error: 'INVALID_PROVIDER' }, 400);
    const credential = await control.acquireCredential(provider);
    if (!credential) return context.json({ error: 'NO_AVAILABLE_KEY' }, 409);
    try {
      const candidates = await providerFetcher[provider]('北京市', 1, credential.secret);
      await control.reportCredential(credential.id, 'success');
      return context.json({ data: { success: true, resultCount: candidates.length } });
    } catch (error) {
      const outcome = error instanceof ProviderRequestError ? error.outcome : 'network';
      await control.reportCredential(credential.id, outcome);
      return context.json({ error: 'PROVIDER_TEST_FAILED', detail: error instanceof Error ? error.message : String(error) }, 502);
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
  app.get('/admin/api/audit', async (context) => context.json({ data: await control.audits(200) }));
  app.get('/admin/api/system', async (context) => {
    const version = await addressDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').first('version');
    return context.json({ data: { node: process.version, platform: process.platform, schemaVersion: version, uptimeSeconds: Math.floor(process.uptime()) } });
  });
  return app;
};

export const createAccessApi = (control: ControlStore) => {
  const app = new Hono();
  const attempts = new Map<string, { count: number; resetAt: number }>();
  app.get('/web-api/v1/auth/status', async (context) => {
    const status = await control.status();
    const authenticated = !status.frontendPasswordEnabled || await control.session(getCookie(context, frontCookie) || '', 'frontend');
    return context.json({ data: { enabled: status.frontendPasswordEnabled, authenticated } });
  });
  app.post('/web-api/v1/auth/login', async (context) => {
    const status = await control.status();
    if (!status.frontendPasswordEnabled) return context.json({ data: { authenticated: true } });
    const ip = context.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
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
  return control.session(match ? decodeURIComponent(match[1]) : '', 'frontend');
};

export const authorizeApiRequest = async (control: ControlStore, request: Request): Promise<boolean> => {
  const value = bearer(request.headers.get('authorization') || undefined);
  return (await control.authorizeApiTokenDetailed(value, request.url.includes('/generate') ? 'generate' : 'read')).status === 'authorized';
};

export const apiAuthorization = async (control: ControlStore, request: Request) => {
  const value = bearer(request.headers.get('authorization') || undefined);
  return control.authorizeApiTokenDetailed(value, request.url.includes('/generate') ? 'generate' : 'read');
};
