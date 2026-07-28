import { serve, type HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import app from './index';
import { openDatabase } from '../database/sqlite.mjs';
import { initializeSqliteDatabase } from '../database/sqlite.mjs';
import { masterKeyFrom } from '../control/security';
import { ControlStore, credentialsFromEnvironment } from '../control/store';
import {
  apiAuthorization, authorizeWebRequest, createAccessApi, createAdminApi,
  createAmapProxyRateLimiter, proxyAmapServiceRequest, requestClientAddress
} from '../control/admin-api';
import { ChinaDataService } from '../china/service';

const integer = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error('API_PORT must be between 1 and 65535');
  return parsed;
};

const databasePath = resolve(process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite');
const database = openDatabase(databasePath);
const controlDatabasePath = resolve(process.env.CONTROL_DATABASE_PATH || 'data/control.sqlite');
const controlDatabase = openDatabase(controlDatabasePath, { migrate: false });
await initializeSqliteDatabase(controlDatabase, new URL('../control/schema.sql', import.meta.url));
await chmod(controlDatabasePath, 0o600);
const control = new ControlStore(controlDatabase, masterKeyFrom(process.env.CONFIG_MASTER_KEY));
await control.initialize(process.env.ADMIN_BOOTSTRAP_PASSWORD, process.env);
await Promise.all(credentialsFromEnvironment(process.env).map((credential) => control.ensureCredential(credential)));
const china = new ChinaDataService(database, control, dirname(databasePath));
await china.initializeTargets();
const port = integer(process.env.API_PORT, 8787);
const hostname = process.env.API_HOST || '0.0.0.0';
const trustProxy = process.env.TRUST_PROXY === 'true';
const staticRoot = resolve(process.env.STATIC_ROOT || 'dist');
const syncControlUrl = process.env.SYNC_CONTROL_URL || 'http://127.0.0.1:8791';
const syncControlPublic = process.env.SYNC_CONTROL_PUBLIC === 'true';
const adminApi = createAdminApi({ control, china, addressDb: database, addressDatabasePath: databasePath, controlDatabasePath, trustProxy });
const accessApi = createAccessApi(control, { trustProxy });
const amapProxyRateLimit = createAmapProxyRateLimiter();
const securityHeaders = (response: Response): Response => {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
};

const staticApp = new Hono<{ Bindings: HttpBindings }>();
staticApp.use('*', serveStatic({ root: staticRoot }));
staticApp.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));

const environment = {
  ADDRESS_DB: database,
  LOCATION_DB: database,
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',
  AMAP_API_KEY: process.env.AMAP_API_KEY,
  GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY,
  GOOGLE_GEOCODING_API_KEY: process.env.GOOGLE_GEOCODING_API_KEY,
  GOOGLE_TRANSLATION_ENABLED: process.env.GOOGLE_TRANSLATION_ENABLED,
  IP_GEOLOCATION_API_URL: process.env.IP_GEOLOCATION_API_URL,
  IP_GEOLOCATION_FALLBACK_API_URL: process.env.IP_GEOLOCATION_FALLBACK_API_URL,
  LIVE_API_MODES: process.env.LIVE_API_MODES,
  ONEMAP_ACCESS_TOKEN: process.env.ONEMAP_ACCESS_TOKEN,
  OS_DATA_HUB_API_KEY: process.env.OS_DATA_HUB_API_KEY,
  OVERPASS_API_URL: process.env.OVERPASS_API_URL,
  PHOTON_API_URL: process.env.PHOTON_API_URL,
  TRUST_PROXY: process.env.TRUST_PROXY,
  YOUDAO_APP_KEY: process.env.YOUDAO_APP_KEY,
  YOUDAO_APP_SECRET: process.env.YOUDAO_APP_SECRET
};

await Promise.all([
  Promise.resolve(app.fetch(new Request(
    'http://127.0.0.1/api/v1/generate?country=US&residential=true&strategy=instant&seed=startup-warmup&requestId=startup-warmup'
  ), environment)),
  Promise.resolve(app.fetch(new Request('http://127.0.0.1/api/v1/countries'), environment))
]).catch(() => undefined);

const server = serve({
  fetch: async (request, node) => {
    const url = new URL(request.url);
    const remoteAddress = node.incoming.socket?.remoteAddress || '';
    const requestBindings = { remoteAddress };
    if (url.pathname.startsWith('/admin/api/')) return securityHeaders(await adminApi.fetch(request, requestBindings));
    if (url.pathname === '/_AMapService' || url.pathname.startsWith('/_AMapService/')) {
      if (!amapProxyRateLimit(requestClientAddress(request, remoteAddress, trustProxy))) {
        return securityHeaders(Response.json({ error: 'RATE_LIMITED' }, {
          status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' }
        }));
      }
      if (!await authorizeWebRequest(control, request)) {
        return securityHeaders(Response.json({ error: 'FRONTEND_AUTH_REQUIRED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } }));
      }
      return securityHeaders(await proxyAmapServiceRequest(control, request, fetch, process.env.ALLOWED_ORIGIN));
    }
    if (url.pathname.startsWith('/web-api/v1/auth/') || url.pathname === '/web-api/v1/config/maps') {
      return securityHeaders(await accessApi.fetch(request, requestBindings));
    }
    if (url.pathname === '/sync-control' || url.pathname.startsWith('/sync-control/')) {
      if (!syncControlPublic) return securityHeaders(new Response('Not Found', { status: 404 }));
      const target = new URL(`${url.pathname.slice('/sync-control'.length) || '/'}${url.search}`, syncControlUrl);
      return securityHeaders(await fetch(new Request(target, request)));
    }
    if (url.pathname.startsWith('/web-api/v1/')) {
      if (!await authorizeWebRequest(control, request)) return securityHeaders(Response.json({ error: 'FRONTEND_AUTH_REQUIRED' }, { status: 401 }));
      const target = new URL(request.url);
      target.pathname = target.pathname.replace(/^\/web-api\/v1/u, '/api/v1');
      const useLiveProvider = target.pathname === '/api/v1/generate' && target.searchParams.get('live') === 'true';
      const amap = useLiveProvider ? await control.acquireCredential('amap') : null;
      const response = await app.fetch(new Request(target, request), { ...environment, ...(amap ? { AMAP_API_KEY: amap.secret } : {}), ...node });
      if (amap) await control.reportCredential(amap.id, response.ok ? 'success' : 'network');
      return securityHeaders(response);
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/api/v1/health') {
        const authorization = await apiAuthorization(control, request);
        if (authorization.status !== 'authorized') {
          const rateLimited = authorization.status === 'rate_limited';
          return securityHeaders(Response.json({ error: rateLimited ? 'RATE_LIMITED' : 'UNAUTHORIZED' }, {
            status: rateLimited ? 429 : 401,
            headers: rateLimited ? { 'Retry-After': '60' } : undefined
          }));
        }
      }
      const useLiveProvider = url.pathname === '/api/v1/generate' && url.searchParams.get('live') === 'true';
      const amap = useLiveProvider ? await control.acquireCredential('amap') : null;
      const response = await app.fetch(request, { ...environment, ...(amap ? { AMAP_API_KEY: amap.secret } : {}), ...node });
      if (amap) await control.reportCredential(amap.id, response.ok ? 'success' : 'network');
      return securityHeaders(response);
    }
    const publicStatic = url.pathname.startsWith('/admin') || url.pathname.startsWith('/access')
      || url.pathname.startsWith('/_astro/') || /\.(?:css|js|svg|png|jpg|jpeg|webp|ico|woff2?)$/iu.test(url.pathname);
    if (!publicStatic) {
      const staticRequest = url.pathname === '/'
        ? new Request(new URL(`/en/${url.search}`, request.url), request)
        : request;
      return securityHeaders(await authorizeWebRequest(control, request)
        ? await staticApp.fetch(staticRequest, node)
        : Response.redirect(new URL('/access/', request.url), 302));
    }
    const response = await staticApp.fetch(request, node);
    if (url.pathname.startsWith('/_astro/')) response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return securityHeaders(response);
  },
  hostname,
  port
}, ({ address, port: listeningPort }) => {
  console.log(`Address service listening on http://${address}:${listeningPort}`);
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  server.close((error) => {
    database.close();
    controlDatabase.close();
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
