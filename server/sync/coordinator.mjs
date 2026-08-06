import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

class SyncBusyError extends Error {
  constructor(jobId) {
    super('An address sync job is already running');
    this.jobId = jobId || null;
  }
}

const errorText = (error) => error instanceof Error ? error.message : String(error);
const errorCode = (error) => error?.code || (error instanceof AggregateError
  ? error.errors.map((entry) => errorCode(entry)).find(Boolean)
  : null);
const jobFileName = (id) => `${id}.json`;

export class SyncCoordinator {
  constructor({
    stateDir,
    runSync,
    now = () => new Date(),
    idFactory = randomUUID,
    lockStaleMs = 5 * 60 * 1000,
    jobTimeoutMs = 90 * 60_000,
    history = null,
    processIsAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  }) {
    this.stateDir = resolve(stateDir);
    this.jobsDir = resolve(this.stateDir, 'jobs');
    this.lockFile = resolve(this.stateDir, 'sync.lock');
    this.runSync = runSync;
    this.now = now;
    this.idFactory = idFactory;
    this.lockStaleMs = lockStaleMs;
    this.jobTimeoutMs = jobTimeoutMs;
    this.history = history;
    this.processIsAlive = processIsAlive;
    this.currentJob = null;
    this.currentTask = null;
    this.recoveredJobs = [];
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await mkdir(this.jobsDir, { recursive: true });
    const lock = await this.recoverLock();
    if (!lock?.invalid) await this.reconcileJobs(lock?.jobId || null);
    this.initialized = true;
  }

  async trigger(trigger = 'manual', { shards = ['all'] } = {}) {
    await this.initialize();
    if (this.currentJob) return { accepted: false, job: this.currentJob };

    const id = `sync-${this.now().toISOString().replace(/[-:.TZ]/gu, '')}-${this.idFactory()}`;
    const job = {
      id,
      trigger,
      status: 'queued',
      phase: 'queued',
      createdAt: this.now().toISOString(),
      startedAt: null,
      completedAt: null,
      releaseId: null,
      heartbeatAt: null,
      deadlineAt: null,
      shards: [...new Set(shards)],
      error: null,
      errorCode: null
    };

    let lock;
    try {
      lock = await this.acquireLock(id);
    } catch (error) {
      if (error instanceof SyncBusyError) {
        const runningJob = error.jobId ? await this.getJob(error.jobId) : null;
        return { accepted: false, job: runningJob || { id: error.jobId, status: 'running' } };
      }
      throw error;
    }

    try {
      await this.writeJob(job);
      await this.history?.queued(job);
    } catch (error) {
      await this.releaseLock(lock);
      throw error;
    }
    this.currentJob = job;
    this.currentTask = this.execute(job, lock);
    return { accepted: true, job };
  }

  async execute(job, lock) {
    const abort = new AbortController();
    let timeout;
    let runTask;
    const heartbeat = setInterval(() => {
      job.heartbeatAt = this.now().toISOString();
      void Promise.all([this.writeLock(lock, job.id), this.writeJob(job), this.history?.heartbeat(job)])
        .catch((error) => console.error('[address-sync] heartbeat persistence failed', error));
    }, 15_000);
    heartbeat.unref?.();
    try {
      const startedAt = this.now();
      Object.assign(job, {
        status: 'running',
        phase: 'build-and-publish',
        startedAt: startedAt.toISOString(),
        heartbeatAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + this.jobTimeoutMs).toISOString()
      });
      await this.writeJob(job);
      await this.history?.started(job);
      const timeoutTask = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(Object.assign(new Error(`Synchronization exceeded ${this.jobTimeoutMs}ms`), { code: 'SYNC_JOB_TIMEOUT' }));
          queueMicrotask(() => abort.abort());
        }, this.jobTimeoutMs);
        timeout.unref?.();
      });
      runTask = Promise.resolve().then(() => this.runSync({
        id: job.id,
        trigger: job.trigger,
        shards: job.shards,
        signal: abort.signal,
        onProgress: async (progress) => {
          job.phase = progress?.phase || job.phase;
          job.progress = progress || {};
          job.heartbeatAt = this.now().toISOString();
          await Promise.all([this.writeJob(job), this.history?.heartbeat(job)]);
        }
      }));
      const result = await Promise.race([runTask, timeoutTask]);
      Object.assign(job, {
        status: 'succeeded',
        phase: 'published',
        completedAt: this.now().toISOString(),
        releaseId: result?.releaseId || job.id,
        actualShards: result?.etl?.selectedShards || job.shards,
        sourceOutcomes: result?.etl?.reports || []
      });
    } catch (error) {
      if (errorCode(error) === 'SYNC_JOB_TIMEOUT' && runTask) {
        job.phase = 'cancelling';
        job.heartbeatAt = this.now().toISOString();
        abort.abort();
        await Promise.all([this.writeJob(job), this.history?.heartbeat(job)])
          .catch((historyError) => console.error('[address-sync] timeout state persistence failed', historyError));
        await runTask.catch(() => {});
      }
      Object.assign(job, {
        status: 'failed',
        phase: 'failed',
        completedAt: this.now().toISOString(),
        error: errorText(error).slice(0, 1000),
        errorCode: errorCode(error),
        actualShards: error?.selectedShards || job.actualShards || job.shards,
        sourceOutcomes: error?.reports || job.sourceOutcomes || []
      });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      abort.abort();
      try {
        await this.writeJob(job);
        await this.history?.completed(job).catch((error) => {
          console.error('[address-sync] history completion persistence failed', error);
        });
      } finally {
        try {
          await this.releaseLock(lock);
        } finally {
          this.currentJob = null;
          this.currentTask = null;
        }
      }
    }
  }

  async acquireLock(jobId, retried = false) {
    try {
      const token = randomUUID();
      const handle = await open(this.lockFile, 'wx');
      const lock = { handle, token };
      await this.writeLock(lock, jobId);
      return lock;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!retried && await this.lockIsStale()) {
        const staleFile = `${this.lockFile}.stale-${randomUUID()}`;
        try {
          await rename(this.lockFile, staleFile);
          await rm(staleFile, { force: true });
          return this.acquireLock(jobId, true);
        } catch (renameError) {
          if (renameError?.code === 'ENOENT') return this.acquireLock(jobId, true);
        }
      }
      throw new SyncBusyError(await this.readLockJobId());
    }
  }

  async writeLock(lock, jobId) {
    const value = Buffer.from(JSON.stringify({
      jobId,
      token: lock.token,
      pid: process.pid,
      heartbeatAt: this.now().toISOString()
    }));
    await lock.handle.write(value, 0, value.length, 0);
    await lock.handle.truncate(value.length);
    await lock.handle.sync();
  }

  async releaseLock(lock) {
    await lock.handle.close().catch(() => {});
    try {
      const current = JSON.parse(await readFile(this.lockFile, 'utf8'));
      if (current.token === lock.token) await rm(this.lockFile, { force: true });
    } catch {}
  }

  async lockIsStale() {
    try {
      const metadata = await stat(this.lockFile);
      return this.now().getTime() - metadata.mtimeMs > this.lockStaleMs;
    } catch {
      return false;
    }
  }

  async readLock() {
    try {
      return JSON.parse(await readFile(this.lockFile, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return { invalid: true };
    }
  }

  async removeLockFile() {
    const staleFile = `${this.lockFile}.stale-${randomUUID()}`;
    try {
      await rename(this.lockFile, staleFile);
      await rm(staleFile, { force: true });
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      return false;
    }
  }

  async recoverLock() {
    const lock = await this.readLock();
    if (!lock) return null;
    const ownerAlive = lock.pid === process.pid
      ? false
      : Number.isSafeInteger(lock.pid) && lock.pid > 0
      ? this.processIsAlive(lock.pid)
      : null;
    if (ownerAlive === false || await this.lockIsStale()) {
      if (await this.removeLockFile()) return null;
    }
    return lock;
  }

  async reconcileJobs(activeJobId) {
    const files = (await readdir(this.jobsDir)).filter((name) => /^sync-[a-zA-Z0-9-]+\.json$/u.test(name));
    for (const name of files) {
      const file = resolve(this.jobsDir, name);
      let job;
      try {
        job = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        continue;
      }
      if (!['queued', 'running'].includes(job.status) || job.id === activeJobId) continue;
      Object.assign(job, {
        status: 'failed',
        phase: 'interrupted',
        completedAt: this.now().toISOString(),
        error: 'Synchronization interrupted before completion',
        errorCode: 'SYNC_JOB_INTERRUPTED'
      });
      await this.writeJob(job);
      await this.history?.completed(job).catch((error) => {
        console.error('[address-sync] recovered history persistence failed', error);
      });
      this.recoveredJobs.push(job);
    }
  }

  async readLockJobId() {
    try {
      return JSON.parse(await readFile(this.lockFile, 'utf8')).jobId || null;
    } catch {
      return null;
    }
  }

  async writeJob(job) {
    const target = resolve(this.jobsDir, jobFileName(job.id));
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await rm(target, { force: true });
      await rename(temporary, target);
    }
  }

  async getJob(id) {
    await this.initialize();
    if (!/^sync-[a-zA-Z0-9-]+$/u.test(String(id || ''))) return null;
    try {
      return JSON.parse(await readFile(resolve(this.jobsDir, jobFileName(id)), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async latestJob() {
    await this.initialize();
    if (this.currentJob) return this.currentJob;
    const files = (await readdir(this.jobsDir)).filter((name) => /^sync-[a-zA-Z0-9-]+\.json$/u.test(name));
    const jobs = (await Promise.all(files.map(async (name) => {
      const file = resolve(this.jobsDir, name);
      return { file, modifiedAt: (await stat(file)).mtimeMs };
    }))).sort((left, right) => right.modifiedAt - left.modifiedAt);
    if (!jobs.length) return null;
    return JSON.parse(await readFile(jobs[0].file, 'utf8'));
  }

  async waitForIdle() {
    await this.currentTask;
  }
}
