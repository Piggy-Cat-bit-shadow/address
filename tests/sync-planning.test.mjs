import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAddressEtl } from '../server/sync/address-etl.mjs';
import { runAddressSync } from '../server/sync/run-address-sync.mjs';
import { countryPlanStatus, planCountryShards } from '../server/sync/country-plan.mjs';
import { SqliteCountryStateStore } from '../server/sync/sqlite-country-state.mjs';
import { openDatabase } from '../server/database/sqlite.mjs';
import {
  assertStorageBudget,
  evaluateStorageBudget,
  measureStorageBytes,
  StorageBudgetExceededError
} from '../server/sync/storage-budget.mjs';

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const shards = ['US', 'CA', 'JP'].map((countryCode) => ({
  id: `fixture-${countryCode.toLowerCase()}`,
  countryCode,
  intervalDays: 30
}));

describe('country sync planning', () => {
  it('initializes every country without reprocessing successful countries', () => {
    const state = { shards: { 'fixture-us': { status: 'imported', lastSuccessfulAt: '2026-07-01T00:00:00Z' } } };
    expect(planCountryShards({ shards, state, mode: 'initial' }).map(({ countryCode }) => countryCode)).toEqual(['CA', 'JP']);
    expect(countryPlanStatus({ shards, state, now: new Date('2026-07-16T00:00:00Z') })).toMatchObject({ total: 3, initialized: 1, pending: 2 });
  });

  it('selects one failed or oldest due country and waits 30 days after success', () => {
    const state = { shards: {
      'fixture-us': { status: 'imported', lastSuccessfulAt: '2026-07-01T00:00:00Z' },
      'fixture-ca': { status: 'failed', lastSuccessfulAt: '2026-06-30T00:00:00Z' },
      'fixture-jp': { status: 'imported', lastSuccessfulAt: '2026-06-01T00:00:00Z' }
    } };
    const planned = planCountryShards({ shards, state, mode: 'daily', now: new Date('2026-07-16T00:00:00Z') });
    expect(planned.map(({ countryCode }) => countryCode)).toEqual(['CA']);
  });

  it('resumes a 27-country-style initialization from the persisted country manifest', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(resolve(cacheDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      shards: { 'fixture-us': { status: 'imported', lastSuccessfulAt: '2026-07-01T00:00:00Z' } }
    }));
    const result = await runAddressEtl({
      cacheDir,
      dataRoot: cacheDir,
      catalog: { schemaVersion: 1, shards: shards.map((shard) => ({ ...shard, source: { id: 'fixture' } })) },
      syncMode: 'initial',
      dryRun: true,
      adapters: { discover: async () => ({ adapter: 'overture', version: 'fixture', sourceBytes: 0 }) }
    });
    expect(result.selectedShards).toEqual(['fixture-ca', 'fixture-jp']);
  });

  it('prioritizes reusable normalized files during initialization', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    await mkdir(resolve(cacheDir, 'normalized'), { recursive: true });
    await writeFile(resolve(cacheDir, 'normalized', 'fixture-jp-fixture.jsonl'), '{}\n');
    const result = await runAddressEtl({
      cacheDir,
      dataRoot: cacheDir,
      catalog: { schemaVersion: 1, shards: shards.map((shard) => ({ ...shard, source: { id: 'fixture' } })) },
      syncMode: 'initial',
      dryRun: true,
      adapters: { discover: async () => ({ adapter: 'overture', version: 'fixture', sourceBytes: 0 }) }
    });
    expect(result.selectedShards).toEqual(['fixture-jp', 'fixture-us', 'fixture-ca']);
  });

  it('passes initial mode to ETL without the daily one-country cap', async () => {
    let options;
    await runAddressSync({
      releaseId: 'fixture-initial',
      environment: { ADDRESS_SYNC_TRIGGER: 'initial' },
      runEtl: async (value) => {
        options = value;
        return { changed: false, dryRun: true };
      }
    });
    expect(options).toMatchObject({ syncMode: 'initial', maxShardsPerRun: Number.MAX_SAFE_INTEGER });
  });

  it('attempts later countries after an initial country fails and persists resumable state', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    const attempted = [];
    await expect(runAddressEtl({
      cacheDir,
      dataRoot: cacheDir,
      catalog: { schemaVersion: 1, shards: shards.slice(0, 2).map((shard) => ({ ...shard, source: { id: 'fixture' } })) },
      syncMode: 'initial',
      maxRecords: 1,
      measureStorage: async () => 0,
      adapters: {
        discover: async (shard) => {
          attempted.push(shard.countryCode);
          if (shard.countryCode === 'US') throw new Error('fixture failure');
          return { adapter: 'overture', version: 'fixture', sourceBytes: 0 };
        },
        materialize: async () => ({ file: resolve(cacheDir, 'fixture.jsonl'), format: 'overture-jsonl', checksum: 'a'.repeat(64), cacheBytes: 0 })
      },
      importer: { importShard: async () => ({ datasetId: 'fixture-ca', acceptedCount: 1, rejectedCount: 0, skipped: false }) }
    })).rejects.toThrow('Address sync failed for 1 country shard');
    const manifest = JSON.parse(await readFile(resolve(cacheDir, 'manifest.json'), 'utf8'));
    expect(attempted).toEqual(['US', 'CA']);
    expect(manifest.shards['fixture-us'].status).toBe('failed');
    expect(manifest.shards['fixture-ca']).toMatchObject({ status: 'imported', lastSuccessfulAt: expect.any(String) });
  });

  it('skips repeated source-quality failures until the source or adapter revision changes', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    let persisted = { schemaVersion: 1, shards: {} };
    let materializations = 0;
    const stateStore = {
      load: async () => structuredClone(persisted),
      save: async (value) => { persisted = structuredClone(value); }
    };
    const catalog = { schemaVersion: 1, shards: [{ ...shards[0], source: { id: 'fixture' } }] };
    const adapters = {
      discover: async () => ({ adapter: 'overture', version: 'fixture-v1', sourceBytes: 0 }),
      materialize: async () => {
        materializations += 1;
        return { file: resolve(cacheDir, 'fixture.jsonl'), format: 'overture-jsonl', checksum: 'a'.repeat(64), cacheBytes: 0 };
      }
    };
    const importer = {
      importShard: async ({ shard, discovery }) => {
        throw Object.assign(new Error(`Shard ${shard.id} produced no valid addresses`), {
          code: 'SOURCE_QUALITY_FAILED', failureSignature: discovery.failureSignature
        });
      }
    };

    await expect(runAddressEtl({ cacheDir, dataRoot: cacheDir, catalog, adapters, importer, stateStore,
      syncMode: 'manual', measureStorage: async () => 0 })).rejects.toThrow('Address sync failed for 1 country shard');
    expect(persisted.shards['fixture-us']).toMatchObject({
      errorCode: 'SOURCE_QUALITY_FAILED', failureSignature: expect.stringContaining('fixture-v1')
    });

    const repeated = await runAddressEtl({ cacheDir, dataRoot: cacheDir, catalog, adapters, importer, stateStore,
      syncMode: 'manual', measureStorage: async () => 0 });
    expect(materializations).toBe(1);
    expect(repeated.reports).toContainEqual(expect.objectContaining({ status: 'source-quality-failed', skipped: true }));
  });

  it('persists 30-day country state in SQLite without double-counting repeated failures', async () => {
    const database = openDatabase(':memory:');
    const store = new SqliteCountryStateStore({ database, shards });
    const failed = {
      schemaVersion: 1,
      shards: {
        'fixture-us': {
          shardId: 'fixture-us', countryCode: 'US', intervalDays: 30, status: 'failed',
          lastSuccessfulAt: '2026-07-01T00:00:00.000Z', lastChecked: '2026-07-16T00:00:00.000Z',
          sourceVersion: 'fixture-v1', errorCode: 'SOURCE_QUALITY_FAILED', failureSignature: 'fixture-signature', error: 'fixture'
        }
      }
    };
    await store.save(failed);
    await store.save(failed);
    const row = await database.prepare('SELECT * FROM sync_country_state WHERE country_code=?').bind('US').first();
    expect(row).toMatchObject({ status: 'failed', failure_count: 1, next_sync_at: '2026-07-31T00:00:00.000Z' });
    expect((await store.load()).shards['fixture-us']).toMatchObject({
      status: 'failed', lastSuccessfulAt: '2026-07-01T00:00:00.000Z', sourceVersion: 'fixture-v1',
      errorCode: 'SOURCE_QUALITY_FAILED', failureSignature: 'fixture-signature'
    });
    database.close();
  });

  it('adds source-quality state columns to an existing database', async () => {
    const database = openDatabase(':memory:', { migrate: false });
    await database.exec(`CREATE TABLE sync_country_state (
      country_code TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      last_success_at TEXT,
      next_sync_at TEXT,
      active_dataset_id TEXT,
      address_count INTEGER NOT NULL DEFAULT 0,
      residential_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )`);
    const store = new SqliteCountryStateStore({ database, shards });
    await expect(store.load()).resolves.toMatchObject({ shards: { 'fixture-us': { status: 'pending' } } });
    const columns = (await database.prepare('PRAGMA table_info(sync_country_state)').all()).results.map(({ name }) => name);
    expect(columns).toEqual(expect.arrayContaining(['source_version', 'failure_code', 'failure_signature']));
    database.close();
  });
});

describe('address storage budget', () => {
  it('measures nested roots once and switches off shadow expansion at the soft limit', async () => {
    const directory = resolve('.data-cache', 'storage-budget-tests', randomUUID());
    directories.push(directory);
    await mkdir(resolve(directory, 'nested'), { recursive: true });
    await writeFile(resolve(directory, 'data.bin'), Buffer.alloc(16));
    await writeFile(resolve(directory, 'nested', 'more.bin'), Buffer.alloc(8));
    expect(await measureStorageBytes([directory, resolve(directory, 'nested')])).toBe(24);
    expect(evaluateStorageBudget({ currentBytes: 39, additionalBytes: 1, softLimitBytes: 40, hardLimitBytes: 45 })).toMatchObject({
      level: 'soft', allowWrite: true, allowShadowExpansion: false
    });
  });

  it('hard-stops projected writes at 45GB-equivalent capacity', () => {
    expect(() => assertStorageBudget({ currentBytes: 44, additionalBytes: 1, softLimitBytes: 40, hardLimitBytes: 45 }))
      .toThrow(StorageBudgetExceededError);
  });

  it('passes the soft-limit shadow policy into the SQLite-compatible importer contract', async () => {
    const cacheDir = resolve('.data-cache', 'storage-budget-tests', randomUUID());
    directories.push(cacheDir);
    let receivedPolicy;
    let persistedState;
    await runAddressEtl({
      cacheDir,
      dataRoot: cacheDir,
      catalog: { schemaVersion: 1, shards: [{ ...shards[0], source: { id: 'fixture' } }] },
      syncMode: 'manual',
      softLimitBytes: 40,
      hardLimitBytes: 5000,
      maxRecords: 1,
      measureStorage: async () => 40,
      stateStore: {
        load: async () => ({ schemaVersion: 1, shards: {} }),
        save: async (value) => { persistedState = value; }
      },
      adapters: {
        discover: async () => ({ adapter: 'overture', version: 'fixture', sourceBytes: 0 }),
        materialize: async () => ({ file: resolve(cacheDir, 'fixture.jsonl'), format: 'overture-jsonl', checksum: 'a'.repeat(64), cacheBytes: 0 })
      },
      importer: {
        importShard: async ({ storagePolicy }) => {
          receivedPolicy = storagePolicy;
          return { datasetId: 'fixture', acceptedCount: 1, rejectedCount: 0, skipped: false };
        }
      }
    });
    expect(receivedPolicy).toMatchObject({ allowShadowExpansion: false, softLimitBytes: 40, hardLimitBytes: 5000 });
    expect(persistedState.shards['fixture-us']).toMatchObject({ status: 'imported', lastSuccessfulAt: expect.any(String) });
  });
});
