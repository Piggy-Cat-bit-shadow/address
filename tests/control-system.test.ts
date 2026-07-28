import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDatabase, initializeSqliteDatabase, type SqliteDatabase } from '../server/database/sqlite.mjs';
import {
  AMAP_PERSONAL_MONTHLY_LIMIT, ControlStore, credentialsFromEnvironment,
  credentialProviderDefaults, DEFAULT_MAP_DISPLAY_CONFIG, mapDisplayConfigFromEnvironment
} from '../server/control/store';
import { decryptSecret, encryptSecret, hashPassword, masterKeyFrom, verifyPassword } from '../server/control/security';
import {
  authorizeWebRequest, createAccessApi, createAdminApi, createAmapProxyRateLimiter,
  proxyAmapServiceRequest, requestClientAddress, testOneMapCredential
} from '../server/control/admin-api';

describe('control database security', () => {
  let database: SqliteDatabase;
  let store: ControlStore;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(async () => {
    database = openDatabase(':memory:', { migrate: false });
    await initializeSqliteDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    store = new ControlStore(database, masterKey);
    await store.initialize('correct horse battery staple');
  });
  afterEach(() => database.close());

  it('hashes passwords and encrypts provider secrets', async () => {
    const password = await hashPassword('a sufficiently long password');
    expect(await verifyPassword('a sufficiently long password', password.hash, password.salt)).toBe(true);
    expect(await verifyPassword('different password', password.hash, password.salt)).toBe(false);
    const encrypted = encryptSecret('provider-secret-value', masterKey);
    expect(encrypted.ciphertext).not.toContain('provider-secret-value');
    expect(decryptSecret(encrypted, masterKey)).toBe('provider-secret-value');
    expect(masterKeyFrom(masterKey.toString('base64'))).toEqual(masterKey);
  });

  it('tests OneMap with a bearer token without returning it', async () => {
    const token = 'fixture.onemap.token';
    const result = await testOneMapCredential(token, async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      return Response.json({ found: 1, totalNumPages: 1, results: [{ POSTAL: '018989' }] });
    });
    expect(result).toEqual({ success: true, resultCount: 1, totalResults: 1, totalPages: 1 });
    expect(JSON.stringify(result)).not.toContain(token);
    await expect(testOneMapCredential(token, async () => {
      throw new Error(`failed with ${token}`);
    })).rejects.toMatchObject({ outcome: 'network', message: 'NETWORK_ERROR' });
  });

  it('creates protected sessions and encrypted API tokens', async () => {
    expect(await store.verifyIdentity('admin', 'correct horse battery staple')).toBe(true);
    const session = await store.createSession('admin');
    expect(await store.session(session.token, 'admin', session.csrf)).toBe(true);
    expect(await store.session(session.token, 'admin', 'wrong')).toBe(false);
    const created = await store.createApiToken({ name: 'integration', scopes: ['generate'], rateLimit: 3 });
    const stored = await database.prepare('SELECT token_hash,token_ciphertext,token_iv,token_tag FROM api_tokens WHERE id=?')
      .bind(created.id).first<Record<string, string>>();
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(stored?.token_ciphertext).toBeTruthy();
    expect(await store.revealApiToken(created.id)).toEqual(created);
    expect(await store.authorizeApiToken(created.token, 'generate')).toMatchObject({ id: created.id });
    expect(await store.authorizeApiToken(created.token, 'read')).toBeNull();
    await store.revokeApiToken(created.id);
    expect(await store.authorizeApiToken(created.token, 'generate')).toBeNull();
    expect(await store.listApiTokens()).toEqual([]);
  });

  it('supports custom token values and editable scope, rate and expiry settings', async () => {
    const customToken = 'addr_custom_fixture_token_1234567890';
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const created = await store.createApiToken({ name: 'custom', token: customToken, scopes: ['*'], rateLimit: 20, expiresAt });
    expect(created.token).toBe(customToken);
    expect(await store.listApiTokens()).toEqual([expect.objectContaining({
      id: created.id, name: 'custom', scopes: ['*'], rate_limit_per_minute: 20, expires_at: expiresAt, token_revealable: true
    })]);
    await store.updateApiToken(created.id, { scopes: ['read'], rateLimit: 7, expiresAt: null });
    expect(await store.listApiTokens()).toEqual([expect.objectContaining({
      id: created.id, scopes: ['read'], rate_limit_per_minute: 7, expires_at: null
    })]);
    expect((await store.authorizeApiTokenDetailed(customToken, 'read')).status).toBe('authorized');
    expect((await store.authorizeApiTokenDetailed(customToken, 'generate')).status).toBe('unauthorized');
    await expect(store.createApiToken({ name: 'duplicate', token: customToken, scopes: ['*'], rateLimit: 1 })).rejects.toThrow('TOKEN_ALREADY_EXISTS');
    await expect(store.createApiToken({ name: 'invalid', token: 'contains whitespace', scopes: ['*'], rateLimit: 1 })).rejects.toThrow('INVALID_TOKEN_VALUE');
  });

  it('migrates legacy API token tables without changing existing authentication hashes', async () => {
    const legacy = openDatabase(':memory:', { migrate: false });
    try {
      const legacySchema = readFileSync(new URL('../server/control/schema.sql', import.meta.url), 'utf8')
        .replace(/^\s*token_(?:ciphertext|iv|tag) TEXT,\r?\n/gmu, '')
        .replace(/^INSERT OR IGNORE INTO control_migrations\(version,applied_at\) VALUES \(4,datetime\('now'\)\);\r?\n/gmu, '');
      await legacy.exec(legacySchema);
      const legacyToken = 'addr_legacy_fixture_token_123456789';
      await legacy.prepare(`INSERT INTO api_tokens(id,name,token_prefix,token_hash,scopes_json,rate_limit_per_minute,created_at)
        VALUES (?,?,?,?,?,?,?)`).bind('legacy-id', 'legacy', legacyToken.slice(0, 12), (await import('../server/control/security')).tokenHash(legacyToken), '["*"]', 60, new Date().toISOString()).run();
      const legacyStore = new ControlStore(legacy, masterKey);
      await legacyStore.initialize('legacy administrator password');
      const columns = (await legacy.prepare('PRAGMA table_info(api_tokens)').all<{ name: string }>()).results.map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(['token_ciphertext', 'token_iv', 'token_tag']));
      expect((await legacyStore.authorizeApiTokenDetailed(legacyToken, 'read')).status).toBe('authorized');
      expect(await legacyStore.listApiTokens()).toEqual([expect.objectContaining({ id: 'legacy-id', token_revealable: false })]);
      await expect(legacyStore.revealApiToken('legacy-id')).rejects.toThrow('API_TOKEN_SECRET_UNAVAILABLE');
    } finally { legacy.close(); }
  });

  it('keeps the current admin session when changing the password', async () => {
    const current = await store.createSession('admin');
    const other = await store.createSession('admin');
    await store.setPassword('admin', 'new administrator password', current.token);
    expect(await store.verifyIdentity('admin', 'new administrator password')).toBe(true);
    expect(await store.session(current.token, 'admin', current.csrf)).toBe(true);
    expect(await store.session(other.token, 'admin', other.csrf)).toBe(false);
  });

  it('refreshes CSRF state for an existing session', async () => {
    const session = await store.createSession('admin');
    const refreshed = await store.refreshSessionCsrf(session.token, 'admin');
    expect(refreshed).toBeTruthy();
    expect(await store.session(session.token, 'admin', session.csrf)).toBe(false);
    expect(await store.session(session.token, 'admin', refreshed || '')).toBe(true);
  });

  it('updates access settings atomically and retains only the current admin session', async () => {
    const current = await store.createSession('admin');
    const other = await store.createSession('admin');
    await store.updateAccessSettings({
      frontendPasswordEnabled: true,
      frontendPassword: 'new frontend password',
      frontendPasswordConfirmation: 'new frontend password',
      apiAuthEnabled: false,
      adminPassword: 'new administrator password',
      adminPasswordConfirmation: 'new administrator password'
    }, current.token);
    expect(await store.status()).toMatchObject({ frontendPasswordEnabled: true, apiAuthEnabled: false });
    expect(await store.verifyIdentity('frontend', 'new frontend password')).toBe(true);
    expect(await store.verifyIdentity('admin', 'new administrator password')).toBe(true);
    expect(await store.session(current.token, 'admin', current.csrf)).toBe(true);
    expect(await store.session(other.token, 'admin', other.csrf)).toBe(false);
  });

  it('persists four independent map display switches without restart overrides', async () => {
    expect(await store.mapDisplayConfig()).toEqual(DEFAULT_MAP_DISPLAY_CONFIG);
    const configured = {
      google: { china: false, international: true },
      amap: { china: true, international: false }
    };
    expect(await store.updateMapDisplayConfig(configured)).toEqual(configured);
    await expect(store.updateMapDisplayConfig({ google: { china: true } })).rejects.toThrow('INVALID_MAP_DISPLAY_CONFIG');
    await store.initialize(undefined, {
      MAP_GOOGLE_CHINA_ENABLED: 'true', MAP_GOOGLE_INTERNATIONAL_ENABLED: 'false',
      MAP_AMAP_CHINA_ENABLED: 'false', MAP_AMAP_INTERNATIONAL_ENABLED: 'true'
    });
    expect(await store.mapDisplayConfig()).toEqual(configured);
    expect(mapDisplayConfigFromEnvironment({
      MAP_GOOGLE_CHINA_ENABLED: 'off', MAP_GOOGLE_INTERNATIONAL_ENABLED: 'yes',
      MAP_AMAP_CHINA_ENABLED: '1', MAP_AMAP_INTERNATIONAL_ENABLED: '0'
    })).toEqual(configured);
  });

  it('encrypts the dedicated AMap browser credential and keeps it outside provider rotation', async () => {
    await store.createBrowserMapCredential({ label: 'Frontend map', apiKey: 'browser-js-key', securityCode: 'browser-security-code' });
    const row = await database.prepare(`SELECT api_key_ciphertext,security_code_ciphertext FROM browser_map_credentials WHERE provider='amap'`)
      .first<{ api_key_ciphertext: string; security_code_ciphertext: string }>();
    expect(JSON.stringify(row)).not.toContain('browser-js-key');
    expect(JSON.stringify(row)).not.toContain('browser-security-code');
    expect(JSON.stringify(await store.browserMapCredentialStatus())).not.toContain('browser-js-key');
    expect(await store.browserMapCredentialStatus()).toMatchObject({ configured: true, enabled: true, label: 'Frontend map', mask: '••••-key' });
    expect(await store.availableProviders()).toEqual([]);
    expect(await store.acquireBrowserMapCredential()).toEqual({ apiKey: 'browser-js-key', securityCode: 'browser-security-code' });
    await store.updateBrowserMapCredential({ apiKey: '', securityCode: '', enabled: false });
    expect(await store.acquireBrowserMapCredential()).toBeNull();
    expect(await store.browserMapCredentialStatus()).toMatchObject({ configured: true, enabled: false, status: 'disabled' });
    await store.updateBrowserMapCredential({ enabled: true, securityCode: 'replacement-security-code' });
    expect(await store.acquireBrowserMapCredential()).toEqual({ apiKey: 'browser-js-key', securityCode: 'replacement-security-code' });
    await store.deleteBrowserMapCredential();
    expect(await store.browserMapCredentialStatus()).toMatchObject({ configured: false, enabled: false });
  });

  it('requires matching password confirmations before changing access settings', async () => {
    const current = await store.createSession('admin');
    await expect(store.updateAccessSettings({
      frontendPassword: 'replacement frontend password',
      frontendPasswordConfirmation: 'different frontend password'
    }, current.token)).rejects.toThrow('PASSWORD_CONFIRM_MISMATCH');
    expect(await store.verifyIdentity('frontend', 'replacement frontend password')).toBe(false);
  });

  it('imports browser-map environment values only into an empty control database', async () => {
    const fresh = openDatabase(':memory:', { migrate: false });
    try {
      await initializeSqliteDatabase(fresh, new URL('../server/control/schema.sql', import.meta.url));
      const freshStore = new ControlStore(fresh, masterKey);
      await freshStore.initialize('fresh administrator password', {
        AMAP_JS_API_KEY: 'environment-js-key', AMAP_JS_SECURITY_CODE: 'environment-security-code',
        MAP_GOOGLE_CHINA_ENABLED: 'false', MAP_AMAP_INTERNATIONAL_ENABLED: 'true'
      });
      expect(await freshStore.mapDisplayConfig()).toEqual({
        google: { china: false, international: true }, amap: { china: false, international: true }
      });
      expect(await freshStore.acquireBrowserMapCredential()).toEqual({ apiKey: 'environment-js-key', securityCode: 'environment-security-code' });
      await freshStore.updateMapDisplayConfig({ google: { china: true, international: false }, amap: { china: true, international: false } });
      await freshStore.updateBrowserMapCredential({ apiKey: 'database-js-key', securityCode: 'database-security-code' });
      await freshStore.initialize(undefined, {
        AMAP_JS_API_KEY: 'replacement-env-key', AMAP_JS_SECURITY_CODE: 'replacement-env-code',
        MAP_GOOGLE_CHINA_ENABLED: 'false', MAP_AMAP_INTERNATIONAL_ENABLED: 'true'
      });
      expect(await freshStore.mapDisplayConfig()).toEqual({ google: { china: true, international: false }, amap: { china: true, international: false } });
      expect(await freshStore.acquireBrowserMapCredential()).toEqual({ apiKey: 'database-js-key', securityCode: 'database-security-code' });
    } finally { fresh.close(); }
  });

  it('returns country-scoped public map configuration without the security code', async () => {
    await store.updateMapDisplayConfig({ google: { china: false, international: true }, amap: { china: true, international: false } });
    await store.addCredential({ provider: 'amap', label: 'WebService', secret: 'server-webservice-key' });
    await store.createBrowserMapCredential({ apiKey: 'public-browser-key', securityCode: 'private-security-code' });
    const app = createAccessApi(store);
    const chinaResponse = await app.request('/web-api/v1/config/maps?country=CN');
    const chinaBody = await chinaResponse.json() as { data: Record<string, unknown> };
    expect(chinaBody.data).toEqual({
      countryCode: 'CN', googleEnabled: false, amapEnabled: true, amapConfigured: true,
      amapApiKey: 'public-browser-key', serviceHost: '/_AMapService'
    });
    expect(JSON.stringify(chinaBody)).not.toContain('private-security-code');
    expect(JSON.stringify(chinaBody)).not.toContain('server-webservice-key');
    const usBody = await (await app.request('/web-api/v1/config/maps?country=US')).json() as { data: Record<string, unknown> };
    expect(usBody.data).toEqual({ countryCode: 'US', googleEnabled: true, amapEnabled: false, amapConfigured: true });
    await store.updateBrowserMapCredential({ enabled: false });
    const disabled = await (await app.request('/web-api/v1/config/maps?country=CN')).json() as { data: Record<string, unknown> };
    expect(disabled.data).toEqual({ countryCode: 'CN', googleEnabled: false, amapEnabled: false, amapConfigured: true });
    expect((await app.request('/web-api/v1/config/maps')).status).toBe(400);
    await store.setPassword('frontend', 'frontend map password');
    await store.setSetting('frontend_password_enabled', true);
    expect((await app.request('/web-api/v1/config/maps?country=CN')).status).toBe(401);
    const session = await store.createSession('frontend');
    const protectedResponse = await app.request('/web-api/v1/config/maps?country=CN', {
      headers: { Cookie: `address_front_session=${session.token}` }
    });
    expect(protectedResponse.status).toBe(200);
    expect(JSON.stringify(await protectedResponse.json())).not.toContain('private-security-code');
  });

  it('supports Google-only, AMap-only, dual and disabled map configurations for China and overseas', async () => {
    await store.createBrowserMapCredential({ apiKey: 'browser-map-key', securityCode: 'server-only-code' });
    const app = createAccessApi(store);
    const scenarios = [
      { google: true, amap: false },
      { google: false, amap: true },
      { google: true, amap: true },
      { google: false, amap: false }
    ];
    for (const scenario of scenarios) {
      await store.updateMapDisplayConfig({
        google: { china: scenario.google, international: scenario.google },
        amap: { china: scenario.amap, international: scenario.amap }
      });
      for (const country of ['CN', 'US']) {
        const body = await (await app.request(`/web-api/v1/config/maps?country=${country}`)).json() as { data: Record<string, unknown> };
        expect(body.data).toMatchObject({ countryCode: country, googleEnabled: scenario.google, amapEnabled: scenario.amap });
        expect(Object.hasOwn(body.data, 'amapApiKey')).toBe(scenario.amap);
        expect(JSON.stringify(body)).not.toContain('server-only-code');
      }
    }
  });

  it('proxies only fixed AMap service paths with the server-side security code', async () => {
    await store.updateMapDisplayConfig({ google: { china: true, international: true }, amap: { china: true, international: false } });
    await store.createBrowserMapCredential({ apiKey: 'browser-js-key', securityCode: 'private-jscode' });
    let upstream = '';
    const response = await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key&keywords=home&jscode=client-value',
      { headers: { Referer: 'https://address.example/' } }
    ), async (input) => {
      upstream = String(input);
      return Response.json({ status: '1', debug: 'private-jscode' }, {
        headers: { 'Cache-Control': 'max-age=60', ETag: 'upstream-tag', Expires: 'tomorrow' }
      });
    }, 'https://address.example');
    expect(response.status).toBe(200);
    const upstreamUrl = new URL(upstream);
    expect(upstreamUrl.origin).toBe('https://restapi.amap.com');
    expect(upstreamUrl.pathname).toBe('/v3/place/text');
    expect(upstreamUrl.searchParams.get('key')).toBe('browser-js-key');
    expect(upstreamUrl.searchParams.get('jscode')).toBe('private-jscode');
    expect(await response.text()).not.toContain('private-jscode');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBe('0');
    expect(response.headers.get('etag')).toBeNull();
    const style = await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v4/map/styles?key=browser-js-key', { headers: { Origin: 'https://address.example' } }
    ), async (input) => {
      expect(new URL(String(input)).origin).toBe('https://webapi.amap.com');
      return Response.json({ ok: true });
    }, 'https://address.example');
    expect(style.status).toBe(200);
    const vectorBytes = new Uint8Array([0, 255, 1, 2]);
    const vector = await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/vectormap?key=browser-js-key&z=4', { headers: { Origin: 'https://address.example' } }
    ), async (input) => {
      expect(new URL(String(input)).origin).toBe('https://fmap01.amap.com');
      expect(new URL(String(input)).pathname).toBe('/v3/vectormap');
      return new Response(vectorBytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public,max-age=3600' } });
    }, 'https://address.example');
    expect([...new Uint8Array(await vector.arrayBuffer())]).toEqual([...vectorBytes]);
    expect(vector.headers.get('cache-control')).toBe('private, no-store');
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/vectormap/extra?key=browser-js-key', { headers: { Origin: 'https://address.example' } }
    ), async () => Response.json({ ok: true }), 'https://address.example')).status).toBe(404);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://attacker.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'https://attacker.example' } }
    ), async () => Response.json({ ok: true }), 'https://address.example')).status).toBe(403);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'http://address.example' } }
    ), async () => Response.json({ ok: true }), 'https://address.example')).status).toBe(403);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'https://address.example' } }
    ), async () => new Response('<html>no</html>', { headers: { 'Content-Type': 'text/html' } }), 'https://address.example')).status).toBe(502);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=wrong', { headers: { Referer: 'https://address.example/' } }
    ))).status).toBe(403);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Origin: 'https://other.example' } }
    ))).status).toBe(403);
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/private?key=browser-js-key', { headers: { Referer: 'https://address.example/' } }
    ))).status).toBe(404);
    await store.updateMapDisplayConfig({ google: { china: true, international: true }, amap: { china: false, international: false } });
    expect((await proxyAmapServiceRequest(store, new Request(
      'https://address.example/_AMapService/v3/place/text?key=browser-js-key', { headers: { Referer: 'https://address.example/' } }
    ))).status).toBe(404);
  });

  it('keeps map administrator responses masked and audit details secret-free', async () => {
    const session = await store.createSession('admin');
    const admin = createAdminApi({
      control: store,
      china: {} as never,
      addressDb: database,
      addressDatabasePath: '',
      controlDatabasePath: ''
    });
    const headers = {
      Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json'
    };
    expect((await admin.request('/admin/api/settings/maps')).status).toBe(401);
    expect((await admin.request('/admin/api/settings/maps', {
      method: 'PUT', headers: { Cookie: headers.Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ google: { china: true, international: false }, amap: { china: true, international: false } })
    })).status).toBe(401);
    const browserLabel = 'browser-label-secret-sentinel';
    const created = await admin.request('/admin/api/maps/amap-browser', {
      method: 'POST', headers, body: JSON.stringify({ label: browserLabel, apiKey: 'admin-browser-key', securityCode: 'admin-security-code' })
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain('admin-browser-key');
    const updated = await admin.request('/admin/api/settings/maps', {
      method: 'PUT', headers, body: JSON.stringify({ google: { china: true, international: false }, amap: { china: true, international: false } })
    });
    expect(updated.status).toBe(200);
    const settings = await (await admin.request('/admin/api/settings/maps', { headers: { Cookie: headers.Cookie } })).json();
    expect(JSON.stringify(settings)).not.toContain('admin-browser-key');
    expect(JSON.stringify(settings)).not.toContain('admin-security-code');
    const providerLabel = 'provider-label-secret-sentinel';
    const providerSecret = 'provider-secret-sentinel';
    expect((await admin.request('/admin/api/providers', {
      method: 'POST', headers, body: JSON.stringify({ provider: 'amap', label: providerLabel, secret: providerSecret })
    })).status).toBe(201);
    const audits = JSON.stringify(await store.audits());
    for (const secret of ['admin-browser-key', 'admin-security-code', browserLabel, providerLabel, providerSecret]) {
      expect(audits).not.toContain(secret);
    }
  });

  it('reveals encrypted credentials only through the authenticated CSRF-protected admin routes', async () => {
    const session = await store.createSession('admin');
    const admin = createAdminApi({ control: store, china: {} as never, addressDb: database, addressDatabasePath: '', controlDatabasePath: '' });
    const headers = {
      Cookie: `address_admin_session=${session.token}; address_admin_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json'
    };
    await store.createBrowserMapCredential({ apiKey: 'reveal-browser-key', securityCode: 'reveal-browser-code' });
    const providerId = await store.addCredential({ provider: 'amap', label: 'reveal-provider', secret: 'reveal-provider-secret' });
    const unauthenticated = await admin.request(`/admin/api/providers/${providerId}/reveal`, { method: 'POST' });
    expect(unauthenticated.status).toBe(401);
    const missingCsrf = await admin.request(`/admin/api/providers/${providerId}/reveal`, { method: 'POST', headers: { Cookie: headers.Cookie } });
    expect(missingCsrf.status).toBe(401);
    const providerResponse = await admin.request(`/admin/api/providers/${providerId}/reveal`, { method: 'POST', headers });
    expect(providerResponse.status).toBe(200);
    expect(await providerResponse.json()).toEqual({ data: { id: providerId, secret: 'reveal-provider-secret' } });
    expect(providerResponse.headers.get('cache-control')).toContain('no-store');
    const browserResponse = await admin.request('/admin/api/maps/amap-browser/reveal', { method: 'POST', headers });
    expect(browserResponse.status).toBe(200);
    expect(await browserResponse.json()).toEqual({ data: { apiKey: 'reveal-browser-key', securityCode: 'reveal-browser-code' } });
    expect(browserResponse.headers.get('cache-control')).toContain('no-store');
    const token = await store.createApiToken({ name: 'reveal-token', token: 'addr_reveal_fixture_token_123456', scopes: ['*'], rateLimit: 60 });
    expect((await admin.request(`/admin/api/tokens/${token.id}/reveal`, { method: 'POST' })).status).toBe(401);
    const tokenMissingCsrf = await admin.request(`/admin/api/tokens/${token.id}/reveal`, { method: 'POST', headers: { Cookie: headers.Cookie } });
    expect(tokenMissingCsrf.status).toBe(401);
    const tokenResponse = await admin.request(`/admin/api/tokens/${token.id}/reveal`, { method: 'POST', headers });
    expect(tokenResponse.status).toBe(200);
    expect(await tokenResponse.json()).toEqual({ data: token });
    expect(tokenResponse.headers.get('cache-control')).toContain('no-store');
    const updatedToken = await admin.request(`/admin/api/tokens/${token.id}`, {
      method: 'PUT', headers, body: JSON.stringify({ scopes: ['read'], rateLimit: 12, expiresAt: null })
    });
    expect(updatedToken.status).toBe(200);
    expect((await updatedToken.json()).data).toEqual([expect.objectContaining({ id: token.id, scopes: ['read'], rate_limit_per_minute: 12, expires_at: null })]);
  });

  it('uses trusted client addresses only when proxy trust is enabled and throttles bursts', () => {
    const request = new Request('https://address.example/', {
      headers: { 'X-Forwarded-For': '198.51.100.20, 10.0.0.1', 'X-Real-IP': '192.0.2.30' }
    });
    expect(requestClientAddress(request, '203.0.113.10', false)).toBe('203.0.113.10');
    expect(requestClientAddress(request, '203.0.113.10', true)).toBe('192.0.2.30');
    expect(requestClientAddress(new Request('https://address.example/', {
      headers: { 'X-Forwarded-For': '198.51.100.20, 10.0.0.1' }
    }), '203.0.113.10', true)).toBe('10.0.0.1');
    const limited = createAmapProxyRateLimiter(2, 1000);
    expect(limited('203.0.113.10', 100)).toBe(true);
    expect(limited('203.0.113.10', 200)).toBe(true);
    expect(limited('203.0.113.10', 300)).toBe(false);
    expect(limited('203.0.113.10', 1100)).toBe(true);
  });

  it('requires a frontend session for protected AMap proxy requests', async () => {
    await store.setPassword('frontend', 'frontend proxy password');
    await store.setSetting('frontend_password_enabled', true);
    const request = new Request('https://address.example/_AMapService/v3/place/text');
    expect(await authorizeWebRequest(store, request)).toBe(false);
    expect(await authorizeWebRequest(store, new Request(request, { headers: { Cookie: 'address_front_session=%invalid' } }))).toBe(false);
    const session = await store.createSession('frontend');
    expect(await authorizeWebRequest(store, new Request(request, {
      headers: { Cookie: `address_front_session=${encodeURIComponent(session.token)}` }
    }))).toBe(true);
  });

  it('does not partially update access settings when password validation fails', async () => {
    await store.setPassword('frontend', 'original frontend password');
    await expect(store.updateAccessSettings({
      frontendPasswordEnabled: true,
      frontendPassword: 'replacement frontend password',
      frontendPasswordConfirmation: 'replacement frontend password',
      adminPassword: 'short',
      adminPasswordConfirmation: 'short'
    }, '')).rejects.toThrow('PASSWORD_LENGTH');
    expect(await store.status()).toMatchObject({ frontendPasswordEnabled: false });
    expect(await store.verifyIdentity('frontend', 'original frontend password')).toBe(true);
    expect(await store.verifyIdentity('frontend', 'replacement frontend password')).toBe(false);
  });

  it('rotates credentials by quota and health without exposing secret values', async () => {
    const first = await store.addCredential({ provider: 'amap', label: 'A', secret: 'key-a', dailyLimit: 1 });
    const second = await store.addCredential({ provider: 'amap', label: 'B', secret: 'key-b', dailyLimit: 10 });
    const listing = await store.listCredentials();
    expect(JSON.stringify(listing)).not.toContain('key-a');
    expect(listing[0]).not.toHaveProperty('qpsLimit');
    expect(listing[0]).not.toHaveProperty('dailyLimit');
    expect(listing[0]).not.toHaveProperty('quotaScopeId');
    expect(await store.availableProviders()).toEqual(['amap']);
    const acquired = await store.acquireCredential('amap');
    expect(acquired?.id).toBe(first);
    await store.reportCredential(first, 'quota');
    expect((await store.acquireCredential('amap'))?.id).toBe(second);
    await store.reportCredential(second, 'auth');
    expect(await store.acquireCredential('amap')).toBeNull();
  });

  it('uses provider-reported quota when the platform exposes it', async () => {
    const id = await store.addCredential({ provider: 'tencent', label: 'Reported', secret: 'reported-key' });
    await store.reportCredential(id, 'success', { used: 199, limit: 200 });
    expect(await store.listCredentials()).toMatchObject([{
      id, quotaUsed: 199, quotaLimit: 200, quotaRemaining: 1, quotaUsageSource: 'provider', quotaPeriod: 'day'
    }]);
    await store.reportCredential(id, 'success', { used: 200, limit: 200 });
    expect(await store.listCredentials()).toMatchObject([{ id, status: 'quota_exhausted', quotaRemaining: 0 }]);
    expect(await store.acquireCredentialById(id)).toBeNull();
  });

  it('imports the same environment credential only once per provider', async () => {
    const first = await store.ensureCredential({ provider: 'onemap', label: 'Environment', secret: 'fixture.onemap.token' });
    const second = await store.ensureCredential({ provider: 'onemap', label: 'Renamed', secret: 'fixture.onemap.token' });
    const otherProvider = await store.ensureCredential({ provider: 'amap', label: 'Amap', secret: 'fixture.onemap.token' });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(otherProvider.created).toBe(true);
    expect(await store.listCredentials()).toHaveLength(2);
  });

  it('uses conservative free-tier defaults for every credential provider', async () => {
    for (const provider of ['amap', 'baidu', 'tencent', 'onemap'] as const) {
      const id = await store.addCredential({ provider, label: provider, secret: `${provider}-fixture` });
      const row = await database.prepare(`SELECT qps_limit,quota_service,quota_period,quota_limit,quota_timezone_offset
        FROM provider_credentials WHERE id=?`).bind(id).first();
      expect(row).toEqual({
        qps_limit: credentialProviderDefaults[provider].qps,
        quota_service: credentialProviderDefaults[provider].service,
        quota_period: credentialProviderDefaults[provider].period,
        quota_limit: credentialProviderDefaults[provider].limit,
        quota_timezone_offset: credentialProviderDefaults[provider].timezoneOffset
      });
    }
    expect(credentialProviderDefaults.amap).toMatchObject({ period: 'month', limit: AMAP_PERSONAL_MONTHLY_LIMIT });
    expect(credentialProviderDefaults.baidu).toMatchObject({ period: 'day', limit: 100 });
    expect(credentialProviderDefaults.tencent).toMatchObject({ period: 'day', limit: 10_000 });
  });

  it('extracts only non-empty provider credentials from environment variables', () => {
    const values = credentialsFromEnvironment({
      AMAP_API_KEY: ' amap-key ', AMAP_API_KEY_2: ' amap-key-2 ', AMAP_API_KEY_10: ' amap-key-10 ', AMAP_API_KEY_TEST: 'ignored', BAIDU_API_KEY: '', TENCENT_API_KEY: undefined, ONEMAP_ACCESS_TOKEN: ' onemap-token ',
      AMAP_JS_API_KEY: 'browser-map-key', AMAP_JS_SECURITY_CODE: 'browser-map-security-code'
    });
    expect(values).toEqual([
      { provider: 'amap', label: 'AMAP_API_KEY', secret: 'amap-key' },
      { provider: 'amap', label: 'AMAP_API_KEY_2', secret: 'amap-key-2' },
      { provider: 'amap', label: 'AMAP_API_KEY_10', secret: 'amap-key-10' },
      { provider: 'onemap', label: 'ONEMAP_ACCESS_TOKEN', secret: 'onemap-token' }
    ]);
  });

  it('tracks OneMap JWT expiry without returning the token', async () => {
    const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: future })}.signature`;
    const id = await store.addCredential({ provider: 'onemap', label: 'Singapore', secret: token });
    const listed = await store.listCredentials();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, provider: 'onemap', status: 'healthy' });
    expect(listed[0].expiresAt).toBe(new Date(future * 1000).toISOString());
    expect(JSON.stringify(listed)).not.toContain(token);
    expect((await store.acquireCredential('onemap'))?.id).toBe(id);
  });

  it('selects the exact credential requested by the admin test action', async () => {
    const first = await store.addCredential({ provider: 'baidu', label: 'First', secret: 'baidu-first' });
    const second = await store.addCredential({ provider: 'baidu', label: 'Second', secret: 'baidu-second' });
    expect((await store.acquireCredentialById(second))?.id).toBe(second);
    expect((await store.acquireCredentialById(first))?.id).toBe(first);
    expect(await store.acquireCredentialById('missing')).toBeNull();
  });

  it('does not acquire expired or malformed OneMap credentials', async () => {
    const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = `${encode({ alg: 'none' })}.${encode({ exp: past })}.signature`;
    await store.addCredential({ provider: 'onemap', label: 'Expired', secret: expired });
    await store.addCredential({ provider: 'onemap', label: 'Malformed', secret: 'not-a-jwt' });
    const listed = await store.listCredentials();
    expect(listed.map((item) => item.status)).toEqual(['expired', 'needs_review']);
    expect(await store.acquireCredential('onemap')).toBeNull();
  });

  it('migrates legacy provider tables and preserves credentials and usage', async () => {
    const legacy = openDatabase(':memory:', { migrate: false });
    try {
      await initializeSqliteDatabase(legacy, new URL('../server/control/schema.sql', import.meta.url));
      const original = new ControlStore(legacy, masterKey);
      const amapId = await original.addCredential({ provider: 'amap', label: 'Existing', secret: 'existing-amap-key' });
      await original.reportCredential(amapId, 'success');
      await legacy.exec(`PRAGMA foreign_keys=OFF;
        BEGIN IMMEDIATE;
        DROP TABLE provider_usage_periods;
        ALTER TABLE provider_usage_daily RENAME TO provider_usage_daily_current;
        ALTER TABLE provider_credentials RENAME TO provider_credentials_current;
        CREATE TABLE provider_credentials (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('amap','baidu','tencent')),
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
        INSERT INTO provider_credentials(id,provider,label,secret_ciphertext,secret_iv,secret_tag,enabled,status,weight,qps_limit,
          daily_limit,quota_scope_id,cooldown_until,failure_count,last_used_at,last_success_at,last_failure_at,created_at,updated_at)
        SELECT id,provider,label,secret_ciphertext,secret_iv,secret_tag,enabled,status,weight,qps_limit,
          daily_limit,quota_scope_id,cooldown_until,failure_count,last_used_at,last_success_at,last_failure_at,created_at,updated_at
        FROM provider_credentials_current;
        INSERT INTO provider_usage_daily SELECT * FROM provider_usage_daily_current;
        DROP TABLE provider_usage_daily_current;
        DROP TABLE provider_credentials_current;
        CREATE INDEX idx_provider_credentials_pick ON provider_credentials(provider,enabled,status,cooldown_until,last_used_at);
        COMMIT;
        PRAGMA foreign_keys=ON;`);

      const migrated = new ControlStore(legacy, masterKey);
      await migrated.initialize('legacy administrator password');
      expect(await migrated.listCredentials()).toMatchObject([{ id: amapId, provider: 'amap', quotaUsed: 1, quotaPeriod: 'month' }]);
      const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const token = `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
      const onemapId = await migrated.addCredential({ provider: 'onemap', label: 'OneMap', secret: token });
      expect((await migrated.acquireCredential('onemap'))?.id).toBe(onemapId);
      expect((await legacy.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      legacy.close();
    }
  });

  it('applies a shared quota scope across multiple keys', async () => {
    const first = await store.addCredential({ provider: 'tencent', label: 'A', secret: 'scope-a', dailyLimit: 1, quotaScopeId: 'shared-account' });
    await store.addCredential({ provider: 'tencent', label: 'B', secret: 'scope-b', dailyLimit: 1, quotaScopeId: 'shared-account' });
    expect((await store.acquireCredential('tencent'))?.id).toBe(first);
    await store.reportCredential(first, 'success');
    expect(await store.acquireCredential('tencent')).toBeNull();
  });

  it('gives keys independent quotas unless a shared scope is explicitly configured', async () => {
    const first = await store.addCredential({ provider: 'amap', label: 'A', secret: 'independent-a', dailyLimit: 1 });
    const second = await store.addCredential({ provider: 'amap', label: 'B', secret: 'independent-b', dailyLimit: 1 });
    expect((await store.acquireCredentialById(first))?.id).toBe(first);
    await store.reportCredential(first, 'success');
    expect(await store.acquireCredentialById(first)).toBeNull();
    expect((await store.acquireCredentialById(second))?.id).toBe(second);
    expect(await store.availableProviders()).toEqual(['amap']);
    await store.reportCredential(second, 'success');
    expect(await store.availableProviders()).toEqual([]);
  });

  it('distinguishes API rate limiting from invalid credentials', async () => {
    const created = await store.createApiToken({ name: 'limited', scopes: ['generate'], rateLimit: 1 });
    expect((await store.authorizeApiTokenDetailed(created.token, 'generate')).status).toBe('authorized');
    expect((await store.authorizeApiTokenDetailed(created.token, 'generate')).status).toBe('rate_limited');
    expect((await store.authorizeApiTokenDetailed('invalid', 'generate')).status).toBe('unauthorized');
  });
});
