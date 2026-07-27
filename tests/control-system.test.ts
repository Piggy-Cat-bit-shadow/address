import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, initializeSqliteDatabase, type SqliteDatabase } from '../server/database/sqlite.mjs';
import { ControlStore } from '../server/control/store';
import { decryptSecret, encryptSecret, hashPassword, masterKeyFrom, verifyPassword } from '../server/control/security';

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

  it('creates protected sessions and one-way API tokens', async () => {
    expect(await store.verifyIdentity('admin', 'correct horse battery staple')).toBe(true);
    const session = await store.createSession('admin');
    expect(await store.session(session.token, 'admin', session.csrf)).toBe(true);
    expect(await store.session(session.token, 'admin', 'wrong')).toBe(false);
    const created = await store.createApiToken({ name: 'integration', scopes: ['generate'], rateLimit: 3 });
    expect(await store.authorizeApiToken(created.token, 'generate')).toMatchObject({ id: created.id });
    expect(await store.authorizeApiToken(created.token, 'read')).toBeNull();
    await store.revokeApiToken(created.id);
    expect(await store.authorizeApiToken(created.token, 'generate')).toBeNull();
  });

  it('keeps the current admin session when changing the password', async () => {
    const current = await store.createSession('admin');
    const other = await store.createSession('admin');
    await store.setPassword('admin', 'new administrator password', current.token);
    expect(await store.verifyIdentity('admin', 'new administrator password')).toBe(true);
    expect(await store.session(current.token, 'admin', current.csrf)).toBe(true);
    expect(await store.session(other.token, 'admin', other.csrf)).toBe(false);
  });

  it('rotates credentials by quota and health without exposing secret values', async () => {
    const first = await store.addCredential({ provider: 'amap', label: 'A', secret: 'key-a', dailyLimit: 1 });
    const second = await store.addCredential({ provider: 'amap', label: 'B', secret: 'key-b', dailyLimit: 10 });
    const listing = await store.listCredentials();
    expect(JSON.stringify(listing)).not.toContain('key-a');
    const acquired = await store.acquireCredential('amap');
    expect(acquired?.id).toBe(first);
    await store.reportCredential(first, 'quota');
    expect((await store.acquireCredential('amap'))?.id).toBe(second);
    await store.reportCredential(second, 'auth');
    expect(await store.acquireCredential('amap')).toBeNull();
  });

  it('applies a shared quota scope across multiple keys', async () => {
    const first = await store.addCredential({ provider: 'tencent', label: 'A', secret: 'scope-a', dailyLimit: 1, quotaScopeId: 'shared-account' });
    await store.addCredential({ provider: 'tencent', label: 'B', secret: 'scope-b', dailyLimit: 1, quotaScopeId: 'shared-account' });
    expect((await store.acquireCredential('tencent'))?.id).toBe(first);
    await store.reportCredential(first, 'success');
    expect(await store.acquireCredential('tencent')).toBeNull();
  });

  it('distinguishes API rate limiting from invalid credentials', async () => {
    const created = await store.createApiToken({ name: 'limited', scopes: ['generate'], rateLimit: 1 });
    expect((await store.authorizeApiTokenDetailed(created.token, 'generate')).status).toBe('authorized');
    expect((await store.authorizeApiTokenDetailed(created.token, 'generate')).status).toBe('rate_limited');
    expect((await store.authorizeApiTokenDetailed('invalid', 'generate')).status).toBe('unauthorized');
  });
});
