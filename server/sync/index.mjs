import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncApi } from './api.mjs';
import { createSyncArtifactCleanup } from './artifact-cleanup.mjs';
import { createPostgresPool, initializePostgres, PostgresDatabase } from '../database/postgres.mjs';
import { SyncCoordinator } from './coordinator.mjs';
import { SyncHistoryStore } from './history-store.mjs';
import { createSyncQueue } from './queue.mjs';
import { runAddressSync, syncPostgresStatementTimeout } from './run-address-sync.mjs';
import { startDailyScheduler } from './scheduler.mjs';
import { createSourceAdapters, loadSourceCatalog } from './source-adapters.mjs';
import { ensureAddressPolicies } from './address-policy.mjs';
import { validatePublishedPoolBatch } from '../database/published-pool.mjs';

const integer = (value, fallback, minimum, maximum) => {
  const number = value === undefined || value === '' ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return number;
};
const enabled = (value) => /^(1|true|yes)$/iu.test(String(value || ''));

export const createPublicationValidationWorker = ({
  validate,
  intervalMs = 1_000,
  log = console
}) => {
  let stopped = true;
  let completed = false;
  let timer;
  let running;

  const run = async () => {
    if (stopped || completed || running) return;
    running = Promise.resolve()
      .then(validate)
      .then((result) => {
        if (result.retired || result.countryCompleted) {
          log.log?.(`[publication-validation] country=${result.countryCode} scanned=${result.scanned} retired=${result.retired}`);
        }
        completed = Boolean(result.completed);
      })
      .catch((error) => log.error?.('[publication-validation] batch failed', error))
      .finally(() => { running = undefined; });
    await running;
    if (!stopped && !completed) timer = setTimeout(() => { void run(); }, intervalMs);
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      void run();
    },
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    }
  };
};

const stripPrefix = (request) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/sync-control')) return request;
  url.pathname = url.pathname.slice('/sync-control'.length) || '/';
  return new Request(url, request);
};

export const createSyncRuntime = async ({
  environment = process.env,
  runSync = runAddressSync,
  database: providedDatabase,
  stateDir = resolve(environment.SYNC_STATE_DIR || '.data-cache/sync-control'),
  utcHour = integer(environment.SYNC_UTC_HOUR, 3, 0, 23),
  now = () => new Date()
} = {}) => {
  let testDatabase;
  if (!providedDatabase && environment.NODE_ENV === 'test' && environment.ADDRESS_TEST_DATABASE === 'memory') {
    const { initializeTestDatabase, openTestDatabase } = await import('../../tests/helpers/postgres-test-database.mjs');
    testDatabase = openTestDatabase(':memory:');
    await initializeTestDatabase(testDatabase, new URL('../control/schema.sql', import.meta.url));
    providedDatabase = testDatabase;
  }
  const postgresPool = providedDatabase ? undefined : createPostgresPool({
    environment,
    statement_timeout: syncPostgresStatementTimeout(environment),
    application_name: 'address-sync'
  });
  if (postgresPool) await initializePostgres(postgresPool);
  const database = providedDatabase || new PostgresDatabase(postgresPool);
  const queueDatabase = providedDatabase || new PostgresDatabase(postgresPool);
  await ensureAddressPolicies(database);
  const scheduleStateFile = resolve(stateDir, 'daily-schedule.json');
  let catalogPromise;
  const catalogShards = () => {
    if (!catalogPromise) {
      catalogPromise = loadSourceCatalog(undefined, environment)
        .then((catalog) => catalog.shards)
        .catch((error) => {
          catalogPromise = null;
          throw error;
        });
    }
    return catalogPromise;
  };
  const history = new SyncHistoryStore(queueDatabase, { catalogShards, now });
  await history.repairInterruptedRuns();
  await history.repairLegacyProjections();
  const coordinator = new SyncCoordinator({
    stateDir,
    now,
    history,
    jobTimeoutMs: integer(environment.SYNC_JOB_TIMEOUT_MS, 90 * 60_000, 60_000, 24 * 60 * 60_000),
    cancelGraceMs: integer(environment.SYNC_CANCEL_GRACE_MS, 30_000, 5_000, 10 * 60_000),
    runSync: ({ id, trigger, shards, signal, onProgress }) => runSync({
      releaseId: id,
      signal,
      onProgress,
      database,
      environment: {
        ...environment,
        ADDRESS_SYNC_JOB_ID: id,
        ADDRESS_SYNC_TRIGGER: trigger,
        ADDRESS_SYNC_SHARDS: shards.join(',')
      }
    })
  });
  await coordinator.initialize();
  const artifactCleanup = environment.ADDRESS_SYNC_CACHE_DIR ? createSyncArtifactCleanup({
    cacheDir: environment.ADDRESS_SYNC_CACHE_DIR,
    isBusy: () => Boolean(coordinator.currentJob),
    staleMs: integer(environment.ADDRESS_SYNC_ARTIFACT_STALE_MS, 6 * 60 * 60_000, 60_000, 30 * 24 * 60 * 60_000),
    intervalMs: integer(environment.ADDRESS_SYNC_CLEANUP_INTERVAL_MS, 15 * 60_000, 60_000, 24 * 60 * 60_000),
    retainRaw: enabled(environment.ADDRESS_SYNC_RETAIN_RAW)
  }) : null;
  artifactCleanup?.start();
  const publicationValidationWorker = createPublicationValidationWorker({
    validate: () => validatePublishedPoolBatch(queueDatabase),
    intervalMs: integer(environment.PUBLICATION_VALIDATION_INTERVAL_MS, 1_000, 100, 60_000)
  });
  const runIdleMaintenance = async () => {
    await artifactCleanup?.runOnce();
  };
  const queue = createSyncQueue({
    environment,
    coordinator,
    stateDir,
    now,
    addressDatabase: queueDatabase,
    controlDatabase: queueDatabase,
    history,
    loadCatalog: async () => ({ shards: await catalogShards() }),
    probeSource: async (shard) => createSourceAdapters({ environment, processConcurrency: 1 })
      .discover(shard, {
        includeAssetSizes: false,
        syncMode: 'probe',
        cacheDir: environment.ADDRESS_SYNC_CACHE_DIR
      }),
    onIdle: runIdleMaintenance
  });
  const handler = createSyncApi({
    coordinator,
    queue,
    token: environment.SYNC_ADMIN_TOKEN,
    allowedOrigin: environment.SYNC_ADMIN_ORIGIN || ''
  });
  const api = (request) => handler(stripPrefix(request));
  let stopScheduler;
  let stopQueue;
  return {
    api,
    database,
    coordinator,
    queue,
    startScheduler: ({ startup = true } = {}) => {
      if (!enabled(environment.SYNC_SCHEDULER_ENABLED)) return () => {};
      if (stopScheduler) return stopScheduler;
      publicationValidationWorker.start();
      stopQueue = queue.start();
      stopScheduler = startDailyScheduler({
        coordinator,
        stateFile: scheduleStateFile,
        utcHour,
        now,
        wakePlanner: async () => {
          await history.schedulerHeartbeat(coordinator.currentJob?.id || null);
          queue.poke();
        }
      });
      if (startup) queue.poke();
      return () => {
        stopScheduler?.();
        stopScheduler = undefined;
        stopQueue?.();
        stopQueue = undefined;
      };
    },
    close: async () => {
      stopScheduler?.();
      stopScheduler = undefined;
      stopQueue = undefined;
      await artifactCleanup?.stop();
      await queue.stop();
      await coordinator.waitForIdle();
      await publicationValidationWorker.stop();
      testDatabase?.close();
      await postgresPool?.end();
    }
  };
};

const toWebRequest = async (request) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return new Request(new URL(request.url || '/', 'http://sync.internal'), {
    method: request.method,
    headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
  });
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const host = process.env.SYNC_HOST || '127.0.0.1';
  const port = integer(process.env.SYNC_PORT, 8791, 1, 65_535);
  const runtime = await createSyncRuntime();
  runtime.startScheduler();
  const server = createServer(async (request, response) => {
    try {
      const webResponse = await runtime.api(await toWebRequest(request));
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
    }
  });
  server.listen(port, host, () => console.log(`Address sync control listening on http://${host}:${port}`));
  let stopBackfill = () => {};
  if (/^(1|true|yes)$/iu.test(String(process.env.TRANSLATION_BACKFILL_ENABLED || ''))) {
    const { startTranslationBackfill } = await import('./translation-backfill.mjs');
    stopBackfill = startTranslationBackfill({
      database: runtime.database,
      isBusy: () => Boolean(runtime.coordinator.currentJob)
    });
    console.log('Translation backfill worker enabled');
  }
  const shutdown = async () => {
    stopBackfill();
    await new Promise((done) => server.close(done));
    await runtime.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
