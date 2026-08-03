import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { createSyncApi } from '../server/sync/api.mjs';
import {
  computeQueueSnapshot, countryFingerprint, createQueueSources, createSyncQueue, evaluateAttempt,
  nextQuotaResetTime, nextWakeAt, orderRunnable, QueueStateStore
} from '../server/sync/queue.mjs';

const directories = [];
const stateDir = () => {
  const directory = resolve('.data-cache', 'sync-queue-tests', randomUUID());
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const iso = (value) => new Date(value).toISOString();

describe('queue ordering', () => {
  it('puts quota-bound countries with an open window first, then largest deficit', () => {
    const ordered = orderRunnable([
      { countryCode: 'TH', deficit: 8590, quotaBound: false },
      { countryCode: 'KR', deficit: 442, quotaBound: true, quotaAvailable: true, quotaResetAt: '2026-08-03T00:03:00Z' },
      { countryCode: 'VN', deficit: 9874, quotaBound: false },
      { countryCode: 'IN', deficit: 18475, quotaBound: false }
    ]);
    expect(ordered.map((entry) => entry.countryCode)).toEqual(['KR', 'IN', 'VN', 'TH']);
  });

  it('orders multiple quota-bound countries by earliest upcoming reset', () => {
    const ordered = orderRunnable([
      { countryCode: 'AA', deficit: 1, quotaBound: true, quotaAvailable: true, quotaResetAt: '2026-08-03T12:00:00Z' },
      { countryCode: 'BB', deficit: 900, quotaBound: true, quotaAvailable: true, quotaResetAt: '2026-08-03T00:00:00Z' }
    ]);
    expect(ordered.map((entry) => entry.countryCode)).toEqual(['BB', 'AA']);
  });
});

describe('attempt evaluation and latching', () => {
  const base = {
    fingerprintBefore: 'fp-1',
    fingerprintAfter: 'fp-1',
    completedAt: '2026-08-02T10:00:00.000Z'
  };

  it('latches a fruitless successful run as source_limited_cache', () => {
    const result = evaluateAttempt({ ...base, jobSucceeded: true, netGrowth: 0 });
    expect(result).toMatchObject({ action: 'latch', reason: 'source_limited_cache', fingerprint: 'fp-1' });
  });

  it('latches deterministic quality failures immediately', () => {
    const result = evaluateAttempt({ ...base, jobSucceeded: false, netGrowth: 0, deterministicFailure: true });
    expect(result.action).toBe('latch');
  });

  it('checks a growing source once and latches a new version that produces no growth', () => {
    const growth = evaluateAttempt({ ...base, jobSucceeded: true, netGrowth: 25 });
    expect(growth).toMatchObject({ action: 'checked', reason: 'source_version_checked', fingerprint: 'fp-1' });
    expect(Date.parse(growth.nextAttemptAt)).toBeGreaterThan(Date.parse(base.completedAt));
    expect(evaluateAttempt({ ...base, jobSucceeded: true, netGrowth: 0, fingerprintAfter: 'fp-2' }))
      .toMatchObject({ action: 'latch', fingerprint: 'fp-2' });
  });

  it('backs off transient failures with a bounded exponential delay instead of latching', () => {
    const first = evaluateAttempt({ ...base, jobSucceeded: false, netGrowth: 0, consecutiveFailures: 0 });
    expect(first).toMatchObject({ action: 'backoff', consecutiveFailures: 1 });
    expect(first.nextAttemptAt).toBe(iso(Date.parse(base.completedAt) + 5 * 60_000));
    const eighth = evaluateAttempt({ ...base, jobSucceeded: false, netGrowth: 0, consecutiveFailures: 7 });
    expect(eighth).toMatchObject({ action: 'suspend', consecutiveFailures: 8, reason: 'retry_suspended' });
    expect(eighth.nextAttemptAt).toBe(iso(Date.parse(base.completedAt) + 24 * 60 * 60_000));
  });

  it('suspends a country after two consecutive timeout failures', () => {
    const first = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0, failureCode: 'SYNC_PROCESS_TIMEOUT', consecutiveFailures: 0
    });
    expect(first).toMatchObject({ action: 'backoff', consecutiveFailures: 1, failureCode: 'SYNC_PROCESS_TIMEOUT' });
    const second = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0, failureCode: 'SYNC_PROCESS_TIMEOUT', consecutiveFailures: 1
    });
    expect(second).toMatchObject({ action: 'suspend', consecutiveFailures: 2, failureCode: 'SYNC_PROCESS_TIMEOUT' });
  });

  it('moves quota-bound countries to waiting_quota instead of latching when the quota is spent', () => {
    const result = evaluateAttempt({
      ...base, jobSucceeded: false, netGrowth: 0,
      quotaBound: true, quotaAvailable: false, quotaResetAt: '2026-08-03T00:03:00Z'
    });
    expect(result).toMatchObject({ action: 'waiting_quota', nextAttemptAt: '2026-08-03T00:03:00Z' });
  });

  it('changes the source fingerprint only when the import revision or source version changes', () => {
    const inputs = { importRevision: 'rev-1', policyUpdatedAt: 'p1', nodeFloorsUpdatedAt: 'n1', sourceVersions: [['shard-a', 'v1']] };
    const fingerprint = countryFingerprint(inputs);
    expect(countryFingerprint({ ...inputs })).toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, importRevision: 'rev-2' })).not.toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, policyUpdatedAt: 'p2' })).toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, nodeFloorsUpdatedAt: 'n2' })).toBe(fingerprint);
    expect(countryFingerprint({ ...inputs, sourceVersions: [['shard-a', 'v2']] })).not.toBe(fingerprint);
  });
});

describe('sleep-until-wake computation', () => {
  const now = new Date('2026-08-02T10:00:00Z');
  it('wakes at the earliest future quota reset or retry time', () => {
    const wake = nextWakeAt([
      { nextAttemptAt: '2026-08-03T00:03:00Z' },
      { nextAttemptAt: '2026-08-02T12:00:00Z' },
      { nextAttemptAt: '2026-08-02T09:00:00Z' },
      { nextAttemptAt: null }
    ], now);
    expect(wake.toISOString()).toBe('2026-08-02T12:00:00.000Z');
  });
  it('returns null when nothing schedules a wake-up', () => {
    expect(nextWakeAt([{ nextAttemptAt: null }, {}], now)).toBeNull();
  });
  it('computes provider quota reset boundaries like the control store', () => {
    expect(nextQuotaResetTime('day', 0, new Date('2026-08-02T10:00:00Z')).toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(nextQuotaResetTime('month', 0, new Date('2026-08-02T10:00:00Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(nextQuotaResetTime('day', 480, new Date('2026-08-02T20:00:00Z')).toISOString()).toBe('2026-08-03T16:00:00.000Z');
  });
});

describe('queue state reset', () => {
  it('clears every terminal state when force targets all countries', async () => {
    const store = new QueueStateStore(resolve(stateDir(), 'queue.json'));
    await store.save({ schemaVersion: 1, countries: {
      PH: { state: 'latched' }, US: { state: 'suspended' }
    } });
    await store.clear(['all']);
    expect((await store.load()).countries).toEqual({});
  });
});

const stubFacts = () => ({
  policies: {
    US: { enabled: true, targetCount: 50_000, updatedAt: 'p-us' },
    NL: { enabled: true, targetCount: 25_000, updatedAt: 'p-nl' },
    KR: { enabled: true, targetCount: 20_000, updatedAt: 'p-kr' },
    SG: { enabled: true, targetCount: 8_000, updatedAt: 'p-sg' },
    NG: { enabled: true, targetCount: 8_000, updatedAt: 'p-ng' },
    TR: { enabled: false, targetCount: 10_000, updatedAt: 'p-tr' },
    CN: { enabled: true, targetCount: 30_000, updatedAt: 'p-cn' }
  },
  counts: { US: 49_938, NL: 6_446, KR: 9_558, SG: 8_000, NG: 0 },
  rules: {
    US: {
      total: { current: 49_938, target: 50_000, met: false },
      administrativeCoverage: { actual: 0.75, target: 1, met: false, covered: 3, total: 4 },
      regionalMinimums: {
        actual: 0.5, target: 1, met: false,
        lowest: { level: 2, minimum: 5, total: 4, covered: 3, qualified: 2, coverageRatio: 0.75, floorRatio: 0.5 },
        level1: null, level2: null,
        overrides: { satisfied: 0, total: 0, met: true }
      }
    }
  },
  shards: {
    US: [{ shardId: 'oa-us', status: 'ready', sourceVersion: 'v1', failureCode: null }],
    NL: [{ shardId: 'oa-nl', status: 'ready', sourceVersion: 'v1', failureCode: null }],
    KR: [{ shardId: 'korea-kapt-residential', status: 'ready', sourceVersion: 'v1', failureCode: null }],
    SG: [{ shardId: 'sg-hdb', status: 'ready', sourceVersion: 'v1', failureCode: null }],
    NG: [{ shardId: 'geofabrik-osm-ng', status: 'failed', sourceVersion: '', failureCode: null }]
  },
  nodeFloorsUpdatedAt: {},
  deficits: { belowTarget: new Set(['US', 'NL', 'KR', 'NG']), belowFloor: new Set() }
});
const stubCatalogShards = [
  { id: 'oa-us', countryCode: 'US' },
  { id: 'oa-nl', countryCode: 'NL' },
  { id: 'korea-kapt-residential', countryCode: 'KR' },
  { id: 'sg-hdb', countryCode: 'SG' }
];
const stubSources = (facts, quota) => ({
  addressFacts: async () => ({
    ...facts,
    deficits: { belowTarget: new Set(facts.deficits.belowTarget), belowFloor: new Set(facts.deficits.belowFloor) }
  }),
  quotaStatus: async (provider) => quota[provider] || { provider, known: false, available: true, nextResetAt: null }
});

describe('queue snapshot', () => {
  const now = new Date('2026-08-02T10:00:00Z');

  it('classifies countries and orders the runnable queue', async () => {
    const facts = stubFacts();
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        geoapify: { provider: 'geoapify', known: true, available: false, nextResetAt: '2026-08-03T00:03:00Z' }
      }),
      catalogShards: stubCatalogShards,
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    const byCountry = Object.fromEntries(snapshot.entries.map((entry) => [entry.countryCode, entry]));
    expect(byCountry.CN).toBeUndefined();
    expect(byCountry.TR).toBeUndefined();
    expect(byCountry.SG.state).toBe('done');
    expect(byCountry.NG).toMatchObject({ state: 'source_limited', reason: 'no_source_shard', position: null });
    expect(byCountry.KR).toMatchObject({ state: 'waiting_quota', nextAttemptAt: '2026-08-03T00:03:00Z', quotaBound: true });
    expect(byCountry.NL).toMatchObject({ state: 'queued', position: 1, deficit: 18_554 });
    expect(byCountry.US).toMatchObject({ state: 'queued', position: 2, deficit: 62, target: 50_000, current: 49_938 });
    expect(byCountry.US.rules).toMatchObject({
      total: { met: false },
      administrativeCoverage: { actual: 0.75, met: false },
      regionalMinimums: { actual: 0.5, met: false }
    });
  });

  it('prioritizes a quota-bound country the moment its window opens', async () => {
    const facts = stubFacts();
    const snapshot = await computeQueueSnapshot({
      sources: stubSources(facts, {
        geoapify: { provider: 'geoapify', known: true, available: true, nextResetAt: '2026-08-03T00:03:00Z' }
      }),
      catalogShards: stubCatalogShards,
      queueState: { schemaVersion: 1, countries: {} },
      now
    });
    const queued = snapshot.entries.filter((entry) => entry.state === 'queued');
    expect(queued.map((entry) => entry.countryCode)).toEqual(['KR', 'NL', 'US']);
    expect(queued[0].position).toBe(1);
  });

  it('honours a latch only while the fingerprint matches and reflects the running job', async () => {
    const facts = stubFacts();
    const fingerprint = countryFingerprint({
      policyUpdatedAt: facts.policies.NL.updatedAt,
      nodeFloorsUpdatedAt: '',
      sourceVersions: [['oa-nl', 'v1']]
    });
    const queueState = { schemaVersion: 1, countries: {
      NL: { latched: true, reason: 'source_limited_cache', fingerprint, latchedAt: '2026-08-01T00:00:00Z' }
    } };
    const latched = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now,
      runningJob: { id: 'sync-1', phase: 'build-and-publish', trigger: 'manual', shards: ['US'] }
    });
    const entries = Object.fromEntries(latched.entries.map((entry) => [entry.countryCode, entry]));
    expect(entries.NL).toMatchObject({ state: 'source_limited', reason: 'source_limited_cache' });
    expect(entries.US).toMatchObject({ state: 'running', jobId: 'sync-1', jobPhase: 'build-and-publish' });
    expect(latched.job).toMatchObject({ id: 'sync-1', shards: ['US'] });

    facts.shards.NL[0].sourceVersion = 'v2';
    const unlatched = await computeQueueSnapshot({
      sources: stubSources(facts, {}), catalogShards: stubCatalogShards, queueState, now
    });
    expect(unlatched.entries.find((entry) => entry.countryCode === 'NL').state).toBe('queued');
  });
});

describe('queue engine', () => {
  const fakeCoordinator = () => {
    const coordinator = {
      currentJob: null,
      calls: [],
      jobStatus: 'succeeded',
      trigger: async (trigger, { shards }) => {
        coordinator.calls.push({ trigger, shards });
        return { accepted: true, job: { id: `sync-${coordinator.calls.length}` } };
      },
      waitForIdle: async () => {},
      getJob: async (id) => ({ id, status: coordinator.jobStatus })
    };
    return coordinator;
  };

  it('runs the deepest deficit, latches a fruitless country, and unlatches on a source change', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['NL']);
    const coordinator = fakeCoordinator();
    const queue = createSyncQueue({
      environment: {},
      coordinator,
      stateDir: stateDir(),
      sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: stubCatalogShards }),
      cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });

    expect(await queue.tick()).toBe(0);
    expect(coordinator.calls).toEqual([{ trigger: 'scheduled', shards: ['NL'] }]);
    const state = await queue.store.load();
    expect(state.countries.NL).toMatchObject({ latched: true, reason: 'source_limited_cache' });

    const idle = await queue.tick();
    expect(coordinator.calls).toHaveLength(1);
    expect(idle).toBeGreaterThan(0);
    expect((await queue.snapshot()).entries.find((entry) => entry.countryCode === 'NL').state).toBe('source_limited');

    facts.shards.NL[0].sourceVersion = 'v3';
    expect((await queue.snapshot()).entries.find((entry) => entry.countryCode === 'NL').state).toBe('queued');
    await queue.tick();
    expect(coordinator.calls).toHaveLength(2);
  });

  it('backs off after a transient failure and checks the current source after growth', async () => {
    const facts = stubFacts();
    facts.deficits.belowTarget = new Set(['US']);
    const coordinator = fakeCoordinator();
    coordinator.jobStatus = 'failed';
    const queue = createSyncQueue({
      environment: {},
      coordinator,
      stateDir: stateDir(),
      sources: stubSources(facts, {}),
      loadCatalog: async () => ({ shards: stubCatalogShards }),
      cooldownMs: 0,
      log: { log: () => {}, error: () => {} }
    });
    await queue.tick();
    const afterFailure = await queue.store.load();
    expect(afterFailure.countries.US).toMatchObject({ latched: false, consecutiveFailures: 1 });
    const entry = (await queue.snapshot()).entries.find((value) => value.countryCode === 'US');
    expect(entry.state).toBe('queued');
    expect(entry.reason).toBe('retry_backoff');
    expect(Date.parse(entry.nextAttemptAt)).toBeGreaterThan(Date.now());

    coordinator.jobStatus = 'succeeded';
    coordinator.trigger = async (trigger, { shards }) => {
      coordinator.calls.push({ trigger, shards });
      facts.counts.US += 40;
      return { accepted: true, job: { id: 'sync-growth' } };
    };
    // Force the retry to be due immediately.
    await queue.store.apply('US', { action: 'backoff', consecutiveFailures: 1, nextAttemptAt: new Date(Date.now() - 1000).toISOString() }, new Date().toISOString());
    await queue.tick();
    expect((await queue.store.load()).countries.US).toMatchObject({
      state: 'checked', reason: 'source_version_checked', consecutiveFailures: 0
    });
    expect((await queue.snapshot()).entries.find((value) => value.countryCode === 'US'))
      .toMatchObject({ state: 'source_limited', reason: 'source_version_checked' });
  });
});

describe('China queue priority', () => {
  it('blocks generic country work while China is incomplete before runtime state exists', async () => {
    const database = openTestDatabase();
    await database.prepare(`INSERT INTO sync_country_policies(
      country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
    ) VALUES ('CN',1,1,10,10,10,10,'2026-08-02T00:00:00Z')`).run();
    const sources = createQueueSources({ addressDatabase: database });
    await expect(sources.chinaPriority(new Date('2026-08-02T10:00:00Z'))).resolves.toMatchObject({
      blocksQueue: true,
      executionState: 'below_target'
    });
    database.close();
  });
});

describe('queue state store', () => {
  it('persists latches across instances and clears on requeue', async () => {
    const directory = stateDir();
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'queue-state.json');
    const store = new QueueStateStore(file);
    await store.apply('NG', { action: 'latch', reason: 'source_limited_cache', fingerprint: 'fp-ng' }, '2026-08-02T00:00:00Z');
    const reloaded = new QueueStateStore(file);
    expect((await reloaded.load()).countries.NG).toMatchObject({ latched: true, fingerprint: 'fp-ng' });
    await reloaded.apply('NG', { action: 'requeue' }, '2026-08-02T01:00:00Z');
    expect((await store.load()).countries.NG).toBeUndefined();
  });
});

describe('queue API endpoint', () => {
  it('requires the admin bearer token and returns queue entries', async () => {
    const api = createSyncApi({
      coordinator: {},
      token: 'queue-token',
      queue: { snapshot: async () => ({
        generatedAt: '2026-08-02T10:00:00.000Z',
        job: null,
        entries: [{ countryCode: 'US', state: 'queued', position: 1, nextAttemptAt: null, reason: null, deficit: 62, target: 50_000, current: 49_938 }]
      }) }
    });
    const denied = await api(new Request('http://sync.test/api/v1/sync/queue'));
    expect(denied.status).toBe(401);
    const response = await api(new Request('http://sync.test/api/v1/sync/queue', {
      headers: { Authorization: 'Bearer queue-token' }
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.entries).toEqual([expect.objectContaining({
      countryCode: 'US', state: 'queued', position: 1, deficit: 62, target: 50_000, current: 49_938
    })]);
  });

  it('reports the queue as unavailable when no engine is attached', async () => {
    const api = createSyncApi({ coordinator: {}, token: 'queue-token' });
    const response = await api(new Request('http://sync.test/api/v1/sync/queue', {
      headers: { Authorization: 'Bearer queue-token' }
    }));
    expect(response.status).toBe(503);
  });
});

describe('queue admin surface structure', () => {
  const adminSource = readFileSync('src/components/SyncAdmin.tsx', 'utf8');
  const adminApiSource = readFileSync('server/control/admin-api.ts', 'utf8');
  it('renders the queue as an independent view with 10s polling', () => {
    expect(adminSource).toContain('sync-queue-panel');
    expect(adminSource).toContain("request<SyncQueueData>('/sync/queue'");
    expect(adminSource).toContain('queue-row');
    expect(adminSource).toContain("syncQueue: '/sync/queue'");
    expect(adminSource).toContain("if (view === 'syncQueue')");
    const addressDataBranch = adminSource.slice(adminSource.indexOf("if (view === 'addressData')"), adminSource.indexOf("if (view === 'syncQueue')"));
    expect(addressDataBranch).not.toContain('<SyncQueuePanel');
    expect(adminSource).toContain("queueTitle: '同步队列'");
    expect(adminSource).toContain("queueTitle: 'Sync queue'");
    expect(adminSource).toContain("total: '国家总量'");
    expect(adminSource).toContain("coverage: '行政区覆盖'");
    expect(adminSource).toContain("minimums: '层级/节点最低数量'");
    expect(adminSource).toContain('rules.administrativeCoverage');
    expect(adminSource).toContain('rules.regionalMinimums');
    expect(adminSource.match(/queueTitle:/gu)).toHaveLength(10);
    expect(adminSource.match(/queueResetIn:/gu)).toHaveLength(10);
  });
  it('proxies the queue through the admin API with the CN worker row merged', () => {
    expect(adminApiSource).toContain("app.get('/admin/api/sync/queue'");
    expect(adminApiSource).toContain("new URL('/api/v1/sync/queue', process.env.SYNC_CONTROL_URL || 'http://127.0.0.1:8791')");
    expect(adminApiSource).toContain("engine: 'china-worker'");
    expect(adminApiSource).toContain('rules: goal.rules');
    expect(adminApiSource).toContain('rules: countryGoal.rules');
  });
});
