import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChinaDataService } from '../server/china/service';
import { ControlStore } from '../server/control/store';
import { initializeTestDatabase, openTestDatabase, type PostgresDatabase } from './helpers/postgres-test-database.mjs';

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWorker extends EventEmitter {
    static instances: FakeWorker[] = [];
    posted: unknown[] = [];
    constructor(readonly url: URL, readonly options: Record<string, unknown>) {
      super();
      FakeWorker.instances.push(this);
    }
    postMessage(value: unknown): void { this.posted.push(value); }
    async terminate(): Promise<number> { return 0; }
  }
  return { Worker: FakeWorker };
});

type FakeWorker = EventEmitter & { url: URL; options: Record<string, unknown>; posted: unknown[] };
const workers = (Worker as unknown as { instances: FakeWorker[] }).instances;

describe('China sync worker controller', () => {
  let addressDb: PostgresDatabase;
  let controlDb: PostgresDatabase;
  let control: ControlStore;
  let service: ChinaDataService;

  beforeEach(async () => {
    workers.length = 0;
    addressDb = openTestDatabase(':memory:');
    controlDb = openTestDatabase(':memory:', { migrate: false });
    await initializeTestDatabase(controlDb, new URL('../server/control/schema.sql', import.meta.url));
    control = new ControlStore(controlDb, Buffer.alloc(32, 9));
    await control.initialize('correct horse battery staple');
    await control.addCredential({ provider: 'amap', label: 'worker-test', secret: 'worker-test-key' });
    service = new ChinaDataService(addressDb, control, undefined, {
      postgresUrl: 'postgresql://test', masterKey: Buffer.alloc(32, 7)
    });
  });

  afterEach(() => {
    service.close();
    addressDb.close();
    controlDb.close();
  });

  it('runs the sync in a worker thread, coalesces concurrent starts, and applies worker results', async () => {
    const runId = await service.start();
    expect(workers).toHaveLength(1);
    const worker = workers[0];
    expect(existsSync(fileURLToPath(worker.url))).toBe(true);
    expect(worker.options.execArgv).toEqual(['--import', 'tsx']);
    expect(worker.options.workerData).toMatchObject({
      postgresUrl: 'postgresql://test',
      runId,
      providers: ['amap']
    });
    expect((worker.options.workerData as { targets: unknown[] }).targets.length).toBeGreaterThan(0);
    await expect(service.start()).rejects.toThrow('CHINA_SYNC_BUSY');
    expect(workers).toHaveLength(1);
    expect(await service.status()).toMatchObject({ running: true, syncState: 'running' });
    worker.emit('message', { type: 'progress', progress: { runId, status: 'running', phase: 'baseline', accepted: 3 } });
    expect(await service.status()).toMatchObject({ progress: { phase: 'baseline', accepted: 3 } });
    worker.emit('message', { type: 'done', syncState: 'source_limited', waitReason: 'validated_sources_exhausted' });
    worker.emit('exit', 0);
    await vi.waitFor(async () => expect(await service.status()).toMatchObject({
      running: false, syncState: 'source_limited', waitReason: 'validated_sources_exhausted'
    }));
  });

  it('marks the run failed and schedules a retry when the worker crashes', async () => {
    const runId = await service.start();
    const worker = workers[0];
    worker.emit('error', new Error('worker exploded'));
    worker.emit('exit', 1);
    await vi.waitFor(async () => {
      const run = (await control.runs(10)).find((value) => value.id === runId);
      expect(run).toMatchObject({ status: 'failed', error_code: 'CHINA_SYNC_WORKER', error_message: 'worker exploded' });
    });
    await vi.waitFor(async () => expect(await service.status()).toMatchObject({
      running: false, nextAttemptAt: expect.any(String)
    }));
  });

  it('asks the active worker to stop on close', async () => {
    await service.start();
    const worker = workers[0];
    service.close();
    expect(worker.posted).toContainEqual({ type: 'stop' });
  });
});
