import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlStore } from '../server/control/store.ts';
import { ProviderCredentialPool } from '../server/sync/provider-credential-pool.mjs';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';

describe('provider credential pool', () => {
  let database;
  let store;
  let pool;

  beforeEach(async () => {
    const masterKey = Buffer.alloc(32, 11);
    database = openTestDatabase(':memory:', { migrate: false });
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    store = new ControlStore(database, masterKey);
    await store.initialize('provider pool test password');
    pool = new ProviderCredentialPool(database, masterKey);
  });

  afterEach(() => database.close());

  it('rotates past exhausted and invalid credentials without exposing secrets', async () => {
    const firstId = await store.addCredential({
      provider: 'mappls', label: 'First', secret: 'mappls-first', qpsLimit: 10_000, quotaLimit: 2
    });
    const secondId = await store.addCredential({
      provider: 'mappls', label: 'Second', secret: 'mappls-second', qpsLimit: 10_000, quotaLimit: 2
    });

    const first = await pool.acquire('mappls');
    expect([firstId, secondId]).toContain(first.id);
    await pool.report(first.id, 'quota');
    const second = await pool.acquire('mappls', { excludeIds: [first.id] });
    expect(second.id).not.toBe(first.id);
    await pool.report(second.id, 'auth');

    expect(await pool.acquire('mappls')).toBeNull();
    const rows = (await database.prepare(`SELECT id,status FROM provider_credentials
      WHERE provider='mappls' ORDER BY id`).all()).results;
    expect(rows.map(({ status }) => status).sort()).toEqual(['needs_review', 'quota_exhausted']);
    expect(JSON.stringify(rows)).not.toContain('mappls-first');
    expect(JSON.stringify(rows)).not.toContain('mappls-second');
  });

  it('restores a credential after cooldown and records usage in both periods', async () => {
    const id = await store.addCredential({
      provider: 'mappls', label: 'Recovering', secret: 'mappls-recovering', qpsLimit: 10_000, quotaLimit: 10
    });
    const credential = await pool.acquire('mappls');
    await pool.report(credential.id, 'network', { retryAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await pool.acquire('mappls')).toBeNull();

    await database.prepare('UPDATE provider_credentials SET cooldown_until=? WHERE id=?')
      .bind(new Date(Date.now() - 1_000).toISOString(), id).run();
    const recovered = await pool.acquire('mappls');
    expect(recovered).toMatchObject({ id, secret: 'mappls-recovering' });
    await pool.report(id, 'success');

    expect(await database.prepare('SELECT accepted_count FROM provider_usage_daily WHERE credential_id=?')
      .bind(id).first('accepted_count')).toBe(1);
    expect(await database.prepare('SELECT accepted_count,rejected_count FROM provider_usage_periods WHERE credential_id=?')
      .bind(id).first()).toEqual({ accepted_count: 1, rejected_count: 1 });
  });

  it('persists provider observations and creates missing quota windows', async () => {
    const id = await store.addCredential({ provider: 'amap', label: 'Observed', secret: 'amap-observed' });
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    await pool.report(id, 'quota', { period: 'day', service: 'place-search-v5', retryAt: resetAt });
    expect(await pool.acquire('amap')).toBeNull();
    expect(await database.prepare(`SELECT period,reset_at FROM provider_quota_observations
      WHERE credential_id=? AND service='place-search-v5' AND period='day'`).bind(id).first())
      .toEqual({ period: 'day', reset_at: resetAt });
    expect(await database.prepare(`SELECT period FROM provider_quota_windows
      WHERE credential_id=? AND service='place-search-v5' ORDER BY period`).bind(id).all())
      .toMatchObject({ results: [{ period: 'day' }, { period: 'month' }] });
  });

  it('enforces a shared Geoapify quota scope across multiple keys', async () => {
    const shared = 'geoapify:shared-project';
    const firstId = await store.addCredential({
      provider: 'geoapify', label: 'First project key', secret: 'geoapify-first',
      qpsLimit: 10_000, quotaLimit: 1, quotaScopeId: shared
    });
    await store.addCredential({
      provider: 'geoapify', label: 'Second project key', secret: 'geoapify-second',
      qpsLimit: 10_000, quotaLimit: 1, quotaScopeId: shared
    });
    const credential = await pool.acquire('geoapify');
    expect(credential.id).toBe(firstId);
    await pool.report(credential.id, 'success');
    expect(await pool.acquire('geoapify')).toBeNull();
  });
});
