import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncApi } from '../server/sync/api.mjs';
import { SyncCoordinator } from '../server/sync/coordinator.mjs';
import { SyncHistoryStore } from '../server/sync/history-store.mjs';
import { createSyncRuntime } from '../server/sync/index.mjs';
import {
  acquireSyncLease, assertSyncMemory, runAddressSync, syncPostgresStatementTimeout
} from '../server/sync/run-address-sync.mjs';
import {
  nextRunAt, startDailyScheduler, triggerDailySync, triggerInitialSync, triggerStartupSync
} from '../server/sync/scheduler.mjs';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';

describe('production deployment artifact', () => {
  it('packages the actual worktree and verifies an immutable image manifest', async () => {
    const deploy = await readFile(new URL('../ops/deploy.sh', import.meta.url), 'utf8');
    const status = await readFile(new URL('../ops/status.sh', import.meta.url), 'utf8');
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(deploy).not.toContain('git archive');
    expect(deploy).toContain('git ls-files -co --exclude-standard');
    expect(deploy).toContain('.release-manifest.sha256');
    expect(deploy).toContain('.image-manifest.sha256');
    expect(deploy).toContain("! -path './.github/*'");
    expect(deploy).toContain("! -name '.env.example'");
    expect(deploy).toContain('IMAGE="address-local:$REL"');
    expect(deploy).toContain("bash ./ops/activate-production-release.sh '$REL' '$IMAGE'");
    expect(deploy).toContain('sha256sum --quiet -c .release-manifest.sha256');
    expect(deploy).toContain('sha256sum --quiet -c .image-manifest.sha256');
    expect(deploy).toContain('docker run --rm --entrypoint sh');
    expect(status).toContain('http://127.0.0.1:20022/api/v1/ready');
    expect(status).toContain('exec -T sync node -e');
    expect(status).not.toContain('/api/v1/health" || true');
    expect(dockerfile).toMatch(/apt-get install[^\n]+\bzstd\b/u);
  });
});

const testDirectories = [];
const testStateDir = () => {
  const directory = resolve('.data-cache', 'sync-control-tests', randomUUID());
  testDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(testDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const deferred = () => {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

describe('address sync coordinator', () => {
  it('persists country timing, growth and scheduler heartbeat history', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    await database.prepare(`INSERT INTO sync_country_policies(
      country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,
      min_per_node,coverage_ratio,level1_min,level2_min,updated_at
    ) VALUES ('US',1,10,0,0,0,0,1,1,0,0,'2026-08-01T00:00:00Z')`).run();
    const history = new SyncHistoryStore(database, {
      catalogShards: async () => [{ id: 'oa-us', countryCode: 'US' }],
      now: () => new Date('2026-08-05T06:00:00Z')
    });
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(), history,
      now: () => new Date('2026-08-05T06:00:00Z'),
      idFactory: () => 'history-job',
      runSync: async () => {
        await database.prepare(`INSERT INTO sync_country_state(
          country_code,status,address_count,residential_count,failure_count,updated_at
        ) VALUES ('US','ready',50,50,0,'2026-08-05T06:00:00Z')`).run();
        return { releaseId: 'history-release' };
      }
    });
    const result = await coordinator.trigger('manual', { shards: ['oa-us'] });
    await coordinator.waitForIdle();
    expect(await database.prepare(`SELECT status,completed_at FROM sync_runs WHERE id=?`).bind(result.job.id).first())
      .toMatchObject({ status: 'succeeded', completed_at: '2026-08-05T06:00:00.000Z' });
    expect(await database.prepare(`SELECT country_code,source_id,status,before_count,after_count,net_growth
      FROM sync_run_countries WHERE run_id=?`).bind(result.job.id).first()).toEqual({
      country_code: 'US', source_id: 'oa-us', status: 'succeeded', before_count: 0, after_count: 50, net_growth: 50
    });
    await history.schedulerHeartbeat();
    expect(await database.prepare(`SELECT heartbeat_at,active_run_id FROM sync_scheduler_state
      WHERE scheduler_id='address-sync'`).first()).toEqual({ heartbeat_at: '2026-08-05T06:00:00.000Z', active_run_id: null });
    database.close();
  });

  it('marks the exact source history row as paused for quota after queue evaluation', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const history = new SyncHistoryStore(database, {
      catalogShards: async () => [{ id: 'korea-kapt-residential', countryCode: 'KR' }],
      now: () => new Date('2026-08-06T00:10:00Z')
    });
    const job = {
      id: 'sync-history-quota', trigger: 'queue', shards: ['korea-kapt-residential'], status: 'queued', phase: 'queued'
    };
    await history.queued(job);
    Object.assign(job, {
      status: 'failed', phase: 'failed', startedAt: '2026-08-06T00:00:00Z',
      heartbeatAt: '2026-08-06T00:09:00Z', deadlineAt: '2026-08-06T01:00:00Z',
      completedAt: '2026-08-06T00:09:00Z', errorCode: 'SOURCE_CREDENTIAL_UNAVAILABLE',
      failurePhase: 'materialize',
      error: 'All Geoapify credentials are unavailable', actualShards: ['korea-kapt-residential'],
      sourceOutcomes: [{ shardId: 'korea-kapt-residential', status: 'failed', errorCode: 'SOURCE_CREDENTIAL_UNAVAILABLE' }]
    });
    await history.started(job);
    await history.completed(job);
    await history.pauseForQuota({
      runId: job.id, countryCode: 'KR', sourceId: 'korea-kapt-residential'
    });
    expect(await database.prepare(`SELECT status,error_code,error_message,failure_phase,started_at,completed_at,net_growth
      FROM sync_run_countries WHERE run_id=? AND country_code=? AND source_id=?`)
      .bind(job.id, 'KR', 'korea-kapt-residential').first()).toEqual({
      status: 'paused_quota', error_code: 'SOURCE_CREDENTIAL_UNAVAILABLE',
      error_message: 'All Geoapify credentials are unavailable',
      failure_phase: 'materialize',
      started_at: '2026-08-06T00:00:00Z', completed_at: '2026-08-06T00:09:00Z', net_growth: 0
    });
    database.close();
  });

  it('keeps terminal queue outcomes pending until source state is applied exactly once', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const history = new SyncHistoryStore(database, {
      catalogShards: async () => [{ id: 'oa-us', countryCode: 'US' }],
      now: () => new Date('2026-08-06T01:00:00Z')
    });
    const job = { id: 'sync-pending-outcome', trigger: 'queue', shards: ['oa-us'], status: 'queued', phase: 'queued' };
    await history.queued(job);
    Object.assign(job, {
      status: 'succeeded', phase: 'published', completedAt: '2026-08-06T01:00:00Z',
      actualShards: ['oa-us'], sourceOutcomes: [{ shardId: 'oa-us', status: 'succeeded', sourceComplete: false }]
    });
    await history.completed(job);

    expect(await history.pendingSourceStateApplications()).toMatchObject([{
      run_id: job.id, country_code: 'US', source_id: 'oa-us', status: 'succeeded', source_complete: 0
    }]);
    await history.markSourceStateApplied({
      runId: job.id, countryCode: 'US', sourceId: 'oa-us', appliedAt: '2026-08-06T01:00:01Z'
    });
    expect(await history.pendingSourceStateApplications()).toEqual([]);
    database.close();
  });

  it('repairs only the latest matching pre-deployment quota history row', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    for (const [id, errorCode, createdAt] of [
      ['quota-old', 'SOURCE_CREDENTIAL_UNAVAILABLE', '2026-08-05T10:00:00Z'],
      ['quota-latest', 'SOURCE_CREDENTIAL_UNAVAILABLE', '2026-08-05T11:00:00Z'],
      ['other-failure', 'SYNC_PROCESS_FAILED', '2026-08-05T12:00:00Z']
    ]) {
      await database.prepare(`INSERT INTO sync_runs(
        id,kind,target_json,status,progress_json,created_at,updated_at
      ) VALUES (?,'address-pool','{}','failed','{}',?,?)`).bind(id, createdAt, createdAt).run();
      await database.prepare(`INSERT INTO sync_run_countries(
        run_id,country_code,source_id,trigger_name,status,error_code,created_at,updated_at
      ) VALUES (?,'KR','korea-kapt-residential','queue','failed',?,?,?)`)
        .bind(id, errorCode, createdAt, createdAt).run();
    }
    const history = new SyncHistoryStore(database, { now: () => new Date('2026-08-06T00:10:00Z') });
    await history.repairQuotaWait({ countryCode: 'KR', sourceId: 'korea-kapt-residential' });
    const rows = (await database.prepare(`SELECT run_id,status FROM sync_run_countries ORDER BY created_at`).all()).results;
    expect(rows).toEqual([
      { run_id: 'quota-old', status: 'failed' },
      { run_id: 'quota-latest', status: 'paused_quota' },
      { run_id: 'other-failure', status: 'failed' }
    ]);
    database.close();
  });

  it('persists task status and rejects concurrent manual runs', async () => {
    const execution = deferred();
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(),
      now: () => new Date('2026-07-16T03:00:00.000Z'),
      idFactory: () => 'job-a',
      runSync: () => execution.promise
    });

    const first = await coordinator.trigger('manual');
    const second = await coordinator.trigger('manual');
    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: false, job: { id: first.job.id } });

    execution.resolve({ releaseId: 'release-a' });
    await coordinator.waitForIdle();
    await expect(coordinator.getJob(first.job.id)).resolves.toMatchObject({
      status: 'succeeded',
      phase: 'published',
      releaseId: 'release-a',
      trigger: 'manual'
    });
  });

  it('stores failures as terminal task state', async () => {
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(),
      idFactory: () => 'job-b',
      runSync: async () => { throw new Error('candidate validation failed'); }
    });
    const result = await coordinator.trigger('scheduled');
    await coordinator.waitForIdle();
    await expect(coordinator.getJob(result.job.id)).resolves.toMatchObject({
      status: 'failed',
      phase: 'failed',
      failurePhase: 'build-and-publish',
      trigger: 'scheduled',
      error: 'candidate validation failed'
    });
  });

  it('redacts credentials from persisted process diagnostics', async () => {
    const failure = Object.assign(new Error(`provider failed apiKey=fixture-secret token:another-secret ${'stack '.repeat(250)}ROOT_CAUSE`), {
      reports: [{ shardId: 'fixture', status: 'failed', error: 'password=source-secret' }]
    });
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(), idFactory: () => 'job-redacted',
      runSync: async () => { throw failure; }
    });
    const result = await coordinator.trigger('scheduled');
    await coordinator.waitForIdle();
    const error = (await coordinator.getJob(result.job.id)).error;
    expect(error).toContain('apiKey=[REDACTED] token:[REDACTED]');
    expect(error).toContain('ROOT_CAUSE');
    expect(error).toHaveLength(1000);
    expect((await coordinator.getJob(result.job.id)).sourceOutcomes[0].error).toBe('password=[REDACTED]');
  });

  it('aborts and fails a job that exceeds its hard deadline', async () => {
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(),
      idFactory: () => 'job-timeout',
      jobTimeoutMs: 20,
      runSync: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    });
    const result = await coordinator.trigger('manual');
    await coordinator.waitForIdle();
    await expect(coordinator.getJob(result.job.id)).resolves.toMatchObject({
      status: 'failed', phase: 'failed', error: 'Synchronization exceeded 20ms', errorCode: 'SYNC_JOB_TIMEOUT'
    });
  });

  it('keeps the execution lock until an aborted worker has actually stopped', async () => {
    const worker = deferred();
    const aborted = deferred();
    let sequence = 0;
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(),
      idFactory: () => `job-timeout-lock-${++sequence}`,
      jobTimeoutMs: 20,
      runSync: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted.resolve();
          worker.promise.then(resolve);
        }, { once: true });
      })
    });
    const first = await coordinator.trigger('manual');
    await aborted.promise;
    const overlapping = await coordinator.trigger('manual');
    expect(overlapping).toMatchObject({ accepted: false, job: { id: first.job.id, phase: 'cancelling' } });
    worker.resolve({});
    await coordinator.waitForIdle();
    await expect(coordinator.getJob(first.job.id)).resolves.toMatchObject({
      status: 'failed', errorCode: 'SYNC_JOB_TIMEOUT'
    });
    const next = await coordinator.trigger('manual');
    expect(next.accepted).toBe(true);
    worker.resolve({});
    await coordinator.waitForIdle();
  });

  it('escalates a worker that ignores cancellation instead of hanging forever', async () => {
    const fatal = vi.fn(() => { throw new Error('fixture supervisor restart'); });
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(),
      idFactory: () => 'job-stuck',
      jobTimeoutMs: 20,
      cancelGraceMs: 20,
      fatal,
      runSync: async () => new Promise(() => {})
    });
    const result = await coordinator.trigger('manual');
    const completed = await Promise.race([
      coordinator.waitForIdle().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 150))
    ]);
    expect(completed).toBe(true);
    expect(fatal).toHaveBeenCalledOnce();
    await expect(coordinator.getJob(result.job.id)).resolves.toMatchObject({
      status: 'failed', errorCode: 'SYNC_WORKER_STUCK'
    });
  });

  it('attributes an all-mode history run only to sources that actually executed', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const history = new SyncHistoryStore(database, {
      catalogShards: async () => [
        { id: 'oa-us', countryCode: 'US' },
        { id: 'oa-ca', countryCode: 'CA' }
      ],
      now: () => new Date('2026-08-05T06:00:00Z')
    });
    const job = {
      id: 'sync-history-all', trigger: 'startup', shards: ['all'], status: 'queued', phase: 'queued'
    };
    await history.queued(job);
    Object.assign(job, {
      status: 'running', phase: 'build-and-publish', startedAt: '2026-08-05T06:00:00Z',
      heartbeatAt: '2026-08-05T06:00:00Z', deadlineAt: '2026-08-05T07:00:00Z'
    });
    await history.started(job);
    Object.assign(job, {
      status: 'succeeded', phase: 'published', completedAt: '2026-08-05T06:10:00Z',
      actualShards: ['oa-us'], sourceOutcomes: [{ shardId: 'oa-us', status: 'succeeded', acceptedCount: 0 }]
    });
    await history.completed(job);
    const rows = (await database.prepare(`SELECT source_id,status,net_growth,error_code,error_message
      FROM sync_run_countries WHERE run_id=? ORDER BY source_id`).bind(job.id).all()).results;
    expect(rows).toEqual([
      { source_id: 'oa-ca', status: 'cancelled', net_growth: null,
        error_code: 'SYNC_SOURCE_NOT_EXECUTED', error_message: null },
      { source_id: 'oa-us', status: 'succeeded', net_growth: 0, error_code: null, error_message: null }
    ]);
    database.close();
  });

  it('does not duplicate country growth across multiple executed sources', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const history = new SyncHistoryStore(database, {
      catalogShards: async () => [
        { id: 'oa-us-a', countryCode: 'US' },
        { id: 'oa-us-b', countryCode: 'US' }
      ],
      now: () => new Date('2026-08-05T06:00:00Z')
    });
    const job = { id: 'sync-history-multi', trigger: 'manual', shards: ['US'], status: 'queued', phase: 'queued' };
    await history.queued(job);
    Object.assign(job, { status: 'running', phase: 'build-and-publish', startedAt: '2026-08-05T06:00:00Z',
      heartbeatAt: '2026-08-05T06:00:00Z', deadlineAt: '2026-08-05T07:00:00Z' });
    await history.started(job);
    Object.assign(job, { status: 'succeeded', phase: 'published', completedAt: '2026-08-05T06:10:00Z',
      actualShards: ['oa-us-a', 'oa-us-b'] });
    await history.completed(job);
    const growth = (await database.prepare(`SELECT net_growth FROM sync_run_countries
      WHERE run_id=? ORDER BY source_id`).bind(job.id).all()).results;
    expect(growth).toEqual([{ net_growth: null }, { net_growth: null }]);
    database.close();
  });

  it('repairs legacy all-source projections using the one source updated in the run window', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    await database.prepare(`INSERT INTO sync_runs(
      id,kind,target_json,status,progress_json,created_at,started_at,completed_at,updated_at
    ) VALUES ('legacy-run','address-pool','{"shards":["all"]}','failed','{}','2026-08-05T05:00:00Z',
      '2026-08-05T05:00:00Z','2026-08-05T06:00:00Z','2026-08-05T06:00:00Z')`).run();
    for (const sourceId of ['oa-us', 'oa-ca']) {
      await database.prepare(`INSERT INTO sync_run_countries(
        run_id,country_code,source_id,trigger_name,status,before_count,after_count,net_growth,
        before_goals_json,after_goals_json,created_at,updated_at
      ) VALUES ('legacy-run',?,?,'startup','failed',10,10,0,'{}','{}','2026-08-05T05:00:00Z','2026-08-05T06:00:00Z')`)
        .bind(sourceId === 'oa-us' ? 'US' : 'CA', sourceId).run();
    }
    await database.prepare(`INSERT INTO sync_shard_state(shard_id,country_code,status,updated_at)
      VALUES ('oa-us','US','failed','2026-08-05T05:30:00Z')`).run();
    const history = new SyncHistoryStore(database, { now: () => new Date('2026-08-05T07:00:00Z') });
    await expect(history.repairLegacyProjections()).resolves.toBe(1);
    expect(await database.prepare(`SELECT status,net_growth,error_code FROM sync_run_countries
      WHERE run_id='legacy-run' AND source_id='oa-ca'`).first()).toEqual({
      status: 'cancelled', net_growth: null, error_code: 'SYNC_SOURCE_NOT_EXECUTED'
    });
    expect(await database.prepare(`SELECT status,error_code FROM sync_run_countries
      WHERE run_id='legacy-run' AND source_id='oa-us'`).first()).toEqual({ status: 'failed', error_code: null });
    database.close();
  });

  it('repairs legacy all-source projections from one source ID in the shared error', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const message = 'hard geofabrik-osm-fr-martinique failed snapshot quality';
    await database.prepare(`INSERT INTO sync_runs(
      id,kind,target_json,status,progress_json,error_message,created_at,started_at,completed_at,updated_at
    ) VALUES ('legacy-error','address-pool','{"shards":["all"]}','failed','{}',?,
      '2026-08-05T05:00:00Z','2026-08-05T05:00:00Z','2026-08-05T06:00:00Z','2026-08-05T06:00:00Z')`)
      .bind(message).run();
    for (const [countryCode, sourceId] of [['FR', 'geofabrik-osm-fr-martinique'], ['US', 'oa-us']]) {
      await database.prepare(`INSERT INTO sync_run_countries(
        run_id,country_code,source_id,trigger_name,status,before_count,after_count,net_growth,
        before_goals_json,after_goals_json,error_message,created_at,updated_at
      ) VALUES ('legacy-error',?,?,'startup','failed',10,10,0,'{}','{}',?,'2026-08-05T05:00:00Z','2026-08-05T06:00:00Z')`)
        .bind(countryCode, sourceId, message).run();
    }
    const history = new SyncHistoryStore(database, { now: () => new Date('2026-08-05T07:00:00Z') });
    await expect(history.repairLegacyProjections()).resolves.toBe(1);
    expect(await database.prepare(`SELECT status,error_code,error_message FROM sync_run_countries
      WHERE run_id='legacy-error' AND source_id='oa-us'`).first()).toEqual({
      status: 'cancelled', error_code: 'SYNC_SOURCE_NOT_EXECUTED', error_message: null
    });
    expect(await database.prepare(`SELECT status,error_message FROM sync_run_countries
      WHERE run_id='legacy-error' AND source_id='geofabrik-osm-fr-martinique'`).first()).toEqual({
      status: 'failed', error_message: message
    });
    database.close();
  });

  it('closes database history left running by a terminated sync container', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    await database.prepare(`INSERT INTO sync_runs(
      id,kind,target_json,status,progress_json,created_at,started_at,updated_at
    ) VALUES ('orphan-history','address-pool','{"shards":["oa-us"]}','running','{}',
      '2026-08-05T05:00:00Z','2026-08-05T05:00:00Z','2026-08-05T05:00:00Z')`).run();
    await database.prepare(`INSERT INTO sync_run_countries(
      run_id,country_code,source_id,trigger_name,status,started_at,created_at,updated_at
    ) VALUES ('orphan-history','US','oa-us','queue','running','2026-08-05T05:00:00Z',
      '2026-08-05T05:00:00Z','2026-08-05T05:00:00Z')`).run();
    const history = new SyncHistoryStore(database, { now: () => new Date('2026-08-05T07:00:00Z') });
    await expect(history.repairInterruptedRuns()).resolves.toBe(1);
    expect(await database.prepare(`SELECT status,error_code,completed_at FROM sync_runs
      WHERE id='orphan-history'`).first()).toEqual({
      status: 'failed', error_code: 'SYNC_JOB_INTERRUPTED', completed_at: '2026-08-05T07:00:00.000Z'
    });
    expect(await database.prepare(`SELECT status,net_growth,error_code FROM sync_run_countries
      WHERE run_id='orphan-history'`).first()).toEqual({
      status: 'failed', net_growth: null, error_code: 'SYNC_JOB_INTERRUPTED'
    });
    database.close();
  });

  it('recovers an orphaned job and removes its dead process lock on startup', async () => {
    const stateDir = testStateDir();
    const jobsDir = resolve(stateDir, 'jobs');
    const job = {
      id: 'sync-orphan', trigger: 'initial', status: 'running', phase: 'build-and-publish',
      createdAt: '2026-07-16T03:00:00.000Z', startedAt: '2026-07-16T03:00:01.000Z', completedAt: null,
      releaseId: null, shards: ['all'], error: null
    };
    await mkdir(jobsDir, { recursive: true });
    await writeFile(resolve(jobsDir, `${job.id}.json`), JSON.stringify(job));
    await writeFile(resolve(stateDir, 'sync.lock'), JSON.stringify({ jobId: job.id, token: 'old', pid: 999_999 }));
    const coordinator = new SyncCoordinator({
      stateDir,
      runSync: async () => ({}),
      processIsAlive: () => false,
      now: () => new Date('2026-07-17T03:00:00.000Z')
    });

    await coordinator.initialize();

    await expect(coordinator.getJob(job.id)).resolves.toMatchObject({
      status: 'failed', phase: 'interrupted', completedAt: '2026-07-17T03:00:00.000Z'
    });
    await expect(readFile(resolve(stateDir, 'sync.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a container lock whose pid was reused by the new process', async () => {
    const stateDir = testStateDir();
    const jobsDir = resolve(stateDir, 'jobs');
    const job = {
      id: 'sync-reused-pid', trigger: 'scheduled', status: 'running', phase: 'build-and-publish',
      createdAt: '2026-07-16T03:00:00.000Z', startedAt: '2026-07-16T03:00:01.000Z', completedAt: null,
      releaseId: null, shards: ['ES'], error: null
    };
    await mkdir(jobsDir, { recursive: true });
    await writeFile(resolve(jobsDir, `${job.id}.json`), JSON.stringify(job));
    await writeFile(resolve(stateDir, 'sync.lock'), JSON.stringify({ jobId: job.id, token: 'old', pid: process.pid }));
    const coordinator = new SyncCoordinator({
      stateDir,
      runSync: async () => ({}),
      processIsAlive: () => true,
      now: () => new Date('2026-07-17T03:00:00.000Z')
    });

    await coordinator.initialize();

    await expect(coordinator.getJob(job.id)).resolves.toMatchObject({
      status: 'failed', phase: 'interrupted', errorCode: 'SYNC_JOB_INTERRUPTED'
    });
    await expect(readFile(resolve(stateDir, 'sync.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('quarantines a malformed lock and reconciles its interrupted job', async () => {
    const stateDir = testStateDir();
    const jobsDir = resolve(stateDir, 'jobs');
    const job = {
      id: 'sync-malformed-lock', trigger: 'queue', status: 'running', phase: 'materialize',
      createdAt: '2026-07-16T03:00:00.000Z', startedAt: '2026-07-16T03:00:01.000Z',
      completedAt: null, shards: ['JP']
    };
    await mkdir(jobsDir, { recursive: true });
    await writeFile(resolve(jobsDir, `${job.id}.json`), JSON.stringify(job));
    await writeFile(resolve(stateDir, 'sync.lock'), '{invalid');
    const coordinator = new SyncCoordinator({
      stateDir,
      runSync: async () => ({}),
      now: () => new Date('2026-07-17T03:00:00.000Z')
    });

    await coordinator.initialize();

    await expect(coordinator.getJob(job.id)).resolves.toMatchObject({
      status: 'failed', phase: 'interrupted', errorCode: 'SYNC_JOB_INTERRUPTED'
    });
    await expect(readFile(resolve(stateDir, 'sync.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('sync management API', () => {
  it('serves health under the /sync-control prefix', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const runtime = await createSyncRuntime({
      environment: { SYNC_ADMIN_TOKEN: 'fixture-token' },
      database,
      stateDir: testStateDir(),
      runSync: async ({ releaseId }) => ({ releaseId, changed: false })
    });
    const response = await runtime.api(new Request('http://localhost/sync-control/healthz'));
    expect(response.status).toBe(200);
    expect(Number(await database.prepare('SELECT COUNT(*) AS total FROM sync_country_policies').first('total')))
      .toBeGreaterThan(0);
    await runtime.close();
    await database.close();
  });

  it('seeds an empty database and dispatches international work without China runtime state', async () => {
    const database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    const runSync = vi.fn(async ({ releaseId }) => ({ releaseId, changed: false }));
    const runtime = await createSyncRuntime({
      environment: { SYNC_ADMIN_TOKEN: 'fixture-token' },
      database,
      stateDir: testStateDir(),
      now: () => new Date('2026-08-07T03:00:00.000Z'),
      runSync
    });

    await runtime.queue.tick();

    expect(Number(await database.prepare('SELECT COUNT(*) AS total FROM sync_country_policies').first('total')))
      .toBeGreaterThan(0);
    expect(runSync).toHaveBeenCalledOnce();
    expect(runSync.mock.calls[0][0].environment.ADDRESS_SYNC_SHARDS).not.toBe('CN');
    await runtime.close();
    await database.close();
  });

  it('requires a bearer token and returns a queryable task ID', async () => {
    const execution = deferred();
    const coordinator = new SyncCoordinator({
      stateDir: testStateDir(),
      idFactory: () => 'job-c',
      runSync: () => execution.promise
    });
    const api = createSyncApi({ coordinator, token: 'test-token' });

    const denied = await api(new Request('http://sync.test/api/v1/sync/jobs', { method: 'POST' }));
    expect(denied.status).toBe(401);

    const accepted = await api(new Request('http://sync.test/api/v1/sync/jobs', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ shards: ['HK'] })
    }));
    const body = await accepted.json();
    expect(accepted.status).toBe(202);
    expect(body.job.id).toMatch(/^sync-/u);
    expect(body.job.shards).toEqual(['HK']);

    const status = await api(new Request(`http://sync.test/api/v1/sync/jobs/${body.job.id}`, {
      headers: { Authorization: 'Bearer test-token' }
    }));
    expect(status.status).toBe(200);
    expect((await status.json()).job.id).toBe(body.job.id);

    execution.resolve({ releaseId: body.job.id });
    await coordinator.waitForIdle();
  });

  it('accepts a locked initial synchronization job', async () => {
    const coordinator = { trigger: vi.fn(async (trigger, { shards }) => ({
      accepted: true,
      job: { id: 'sync-initial', trigger, shards, status: 'queued' }
    })) };
    const api = createSyncApi({ coordinator, token: 'test-token' });
    const response = await api(new Request('http://sync.test/api/v1/sync/jobs', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'initial', shards: ['all'] })
    }));
    expect(response.status).toBe(202);
    expect(coordinator.trigger).toHaveBeenCalledWith('initial', { shards: ['all'] });
  });

  it('clears source terminal states before a forced synchronization job', async () => {
    const coordinator = { trigger: vi.fn(async (trigger, { shards }) => ({
      accepted: true,
      job: { id: 'sync-force', trigger, shards, status: 'queued' }
    })) };
    const queue = { force: vi.fn(async () => undefined) };
    const api = createSyncApi({ coordinator, queue, token: 'test-token' });
    const response = await api(new Request('http://sync.test/api/v1/sync/jobs', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'force', shards: ['CN', 'PH'] })
    }));
    expect(response.status).toBe(202);
    expect(queue.force).toHaveBeenCalledWith(['CN', 'PH']);
    expect(coordinator.trigger).toHaveBeenCalledWith('force', { shards: ['CN', 'PH'] });
  });

});

describe('atomic address release command', () => {
  it('gives offline PostgreSQL imports a bounded timeout independent from API queries', () => {
    expect(syncPostgresStatementTimeout({})).toBe(900_000);
    expect(syncPostgresStatementTimeout({ ADDRESS_SYNC_POSTGRES_STATEMENT_TIMEOUT_MS: '1200000' })).toBe(1_200_000);
    expect(syncPostgresStatementTimeout({ ADDRESS_SYNC_POSTGRES_STATEMENT_TIMEOUT_MS: '0' })).toBe(900_000);
  });

  it('rejects a synchronization process before materialization when free memory is below the configured floor', () => {
    expect(() => assertSyncMemory(512, 1024)).toThrow(/requires 1024 free bytes/u);
    expect(() => assertSyncMemory(1024, 1024)).not.toThrow();
  });
  it('prevents concurrent ETL processes and removes the lease after completion', async () => {
    const directory = testStateDir();
    const lockFile = resolve(directory, 'address.postgres.sync.lock');
    const release = await acquireSyncLease(lockFile);
    await expect(acquireSyncLease(lockFile)).rejects.toMatchObject({ code: 'ADDRESS_SYNC_ALREADY_RUNNING' });
    await release();
    const releaseAgain = await acquireSyncLease(lockFile);
    await releaseAgain();
  });

  it('forces a metadata check for a manual shard sync', async () => {
    let options;
    await runAddressSync({
      releaseId: 'manual-check',
      environment: { ADDRESS_SYNC_TRIGGER: 'manual', ADDRESS_SYNC_SHARDS: 'HK' },
      runEtl: async (value) => {
        options = value;
        return { dryRun: true, changed: false };
      }
    });
    expect(options).toMatchObject({ requestedShards: ['HK'], force: true });
  });

  it('passes multiple requested countries to ETL as separate shards', async () => {
    let options;
    await runAddressSync({
      releaseId: 'multi-country',
      environment: { ADDRESS_SYNC_TRIGGER: 'manual', ADDRESS_SYNC_SHARDS: 'HK, US' },
      runEtl: async (value) => {
        options = value;
        return { dryRun: true, changed: false };
      }
    });
    expect(options.requestedShards).toEqual(['HK', 'US']);
  });

  it('publishes only through a successful PostgreSQL ETL transaction', async () => {
    const result = await runAddressSync({
      releaseId: 'release-ok',
      runEtl: async () => ({ changed: true, releaseTargets: [{ countryCode: 'US' }] })
    });
    expect(result).toMatchObject({ releaseId: 'release-ok', changed: true });
  });

  it('propagates a PostgreSQL country transaction failure', async () => {
    await expect(runAddressSync({
      releaseId: 'release-failed',
      environment: { ADDRESS_SYNC_RETRY_ATTEMPTS: '1' },
      runEtl: async () => { throw new Error('PostgreSQL transaction failed'); }
    })).rejects.toThrow('PostgreSQL transaction failed');
  });

  it('retries a failed country synchronization with bounded exponential backoff', async () => {
    const waits = [];
    let calls = 0;
    const result = await runAddressSync({
      releaseId: 'release-retry',
      environment: { ADDRESS_SYNC_RETRY_ATTEMPTS: '3', ADDRESS_SYNC_RETRY_BASE_MS: '7' },
      runEtl: async () => {
        calls += 1;
        if (calls < 3) throw new Error('temporary source failure');
        return { changed: true };
      },
      wait: async (milliseconds) => waits.push(milliseconds)
    });
    expect(result.changed).toBe(true);
    expect(calls).toBe(3);
    expect(waits).toEqual([7, 14]);
  });

  it('does not retry deterministic source quality failures', async () => {
    const waits = [];
    let calls = 0;
    await expect(runAddressSync({
      releaseId: 'release-quality-failed',
      environment: { ADDRESS_SYNC_RETRY_ATTEMPTS: '3', ADDRESS_SYNC_RETRY_BASE_MS: '7' },
      runEtl: async () => {
        calls += 1;
        throw new AggregateError([
          Object.assign(new Error('degraded snapshot'), { code: 'SNAPSHOT_QUALITY_FAILED' })
        ], 'Address sync failed');
      },
      wait: async (milliseconds) => waits.push(milliseconds)
    })).rejects.toThrow('Address sync failed');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('does not immediately retry a timed-out synchronization process', async () => {
    let calls = 0;
    await expect(runAddressSync({
      releaseId: 'release-process-timeout',
      environment: { ADDRESS_SYNC_RETRY_ATTEMPTS: '3' },
      runEtl: async () => {
        calls += 1;
        throw Object.assign(new Error('python exceeded deadline'), { code: 'SYNC_PROCESS_TIMEOUT' });
      }
    })).rejects.toMatchObject({ code: 'SYNC_PROCESS_TIMEOUT' });
    expect(calls).toBe(1);
  });
});

describe('daily due-shard synchronization schedule', () => {
  it('wakes the unified queue planner instead of creating an all-source job', async () => {
    const callbacks = [];
    const coordinator = { trigger: vi.fn() };
    const wakePlanner = vi.fn(async () => undefined);
    const stop = startDailyScheduler({
      coordinator, stateFile: resolve(testStateDir(), 'daily.json'), wakePlanner,
      now: () => new Date('2026-08-05T02:00:00Z'),
      setTimer: (callback) => {
        const timer = { callback, unref: () => {} };
        callbacks.push(timer);
        return timer;
      }
    });
    await callbacks[0].callback();
    stop();
    expect(wakePlanner).toHaveBeenCalledOnce();
    expect(coordinator.trigger).not.toHaveBeenCalled();
  });

  it('checks for due 30-day shards at the next 03:00 UTC boundary', () => {
    expect(nextRunAt(new Date('2026-07-16T10:30:00.000Z'), 3).toISOString())
      .toBe('2026-07-17T03:00:00.000Z');
    expect(nextRunAt(new Date('2026-07-19T03:00:00.000Z'), 3).toISOString())
      .toBe('2026-07-20T03:00:00.000Z');
  });

  it('runs at most one automatic job per UTC day after the configured hour', async () => {
    const coordinator = { trigger: vi.fn(async () => ({ accepted: true, job: { id: 'sync-startup' } })) };
    const stateFile = resolve(testStateDir(), 'daily-schedule.json');
    const now = () => new Date('2026-07-16T03:10:00.000Z');
    await triggerStartupSync(coordinator, { stateFile, utcHour: 3, now });
    await triggerDailySync({ coordinator, stateFile, utcHour: 3, now, trigger: 'scheduled' });
    expect(coordinator.trigger).toHaveBeenCalledWith('startup', { shards: ['all'] });
    expect(coordinator.trigger).toHaveBeenCalledTimes(1);
  });

  it('does not start the daily country sync before 03:00 UTC', async () => {
    const coordinator = { trigger: vi.fn(async () => ({ accepted: true, job: { id: 'sync-early' } })) };
    const result = await triggerStartupSync(coordinator, {
      stateFile: resolve(testStateDir(), 'daily-schedule.json'),
      utcHour: 3,
      now: () => new Date('2026-07-16T02:59:59.000Z')
    });
    expect(result).toMatchObject({ accepted: false, reason: 'before-window' });
    expect(coordinator.trigger).not.toHaveBeenCalled();
  });

  it('records success rather than acceptance and compensates a same-day failure', async () => {
    const jobs = [
      { id: 'sync-failed', status: 'failed', error: 'temporary failure' },
      { id: 'sync-succeeded', status: 'succeeded' }
    ];
    let index = 0;
    const coordinator = {
      trigger: vi.fn(async () => ({ accepted: true, job: jobs[index++] })),
      waitForIdle: vi.fn(async () => {}),
      getJob: vi.fn(async (id) => jobs.find((job) => job.id === id))
    };
    const waits = [];
    const stateFile = resolve(testStateDir(), 'daily-schedule.json');
    let currentTime = new Date('2026-07-17T03:10:00.000Z').getTime();
    const result = await triggerDailySync({
      coordinator,
      stateFile,
      trigger: 'scheduled',
      now: () => new Date(currentTime),
      maxAttempts: 2,
      retryBaseMs: 25,
      waitFor: async (milliseconds) => {
        waits.push(milliseconds);
        currentTime += milliseconds;
      }
    });
    expect(result.job.status).toBe('succeeded');
    expect(coordinator.trigger).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([25]);
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({
      lastSuccessDate: '2026-07-17', attemptCount: 2, lastJobId: 'sync-succeeded'
    });
  });

  it('persists failed initial work and marks it complete after a resumed run', async () => {
    const jobs = [
      { id: 'sync-initial-failed', status: 'failed', error: 'source unavailable' },
      { id: 'sync-initial-ok', status: 'succeeded' }
    ];
    let index = 0;
    const coordinator = {
      trigger: vi.fn(async () => ({ accepted: true, job: jobs[index++] })),
      waitForIdle: vi.fn(async () => {}),
      getJob: vi.fn(async (id) => jobs.find((job) => job.id === id))
    };
    const stateFile = resolve(testStateDir(), 'initial-schedule.json');
    const now = () => new Date('2026-07-17T03:10:00.000Z');
    const failed = await triggerInitialSync({ coordinator, stateFile, now, retryBaseMs: 25 });
    expect(failed).toMatchObject({ completed: false, job: { status: 'failed' } });
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ completed: false, failureCount: 1 });

    const resumed = await triggerInitialSync({ coordinator, stateFile, now, retryBaseMs: 25 });
    expect(resumed).toMatchObject({ completed: true, job: { status: 'succeeded' } });
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ completed: true, failureCount: 0 });
  });
});
