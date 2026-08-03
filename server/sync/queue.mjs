import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadSourceCatalog } from './source-adapters.mjs';
import { evaluateCountryGoals } from './country-goals.mjs';
// Read-only import: postgres-address-importer.mjs is owned by the import pipeline.
// A revision bump there changes every country fingerprint and unlatches cached
// source-limited countries automatically.
import { ADDRESS_IMPORT_REVISION } from './postgres-address-importer.mjs';

export const LATCH_REASON = 'source_limited_cache';
export const CHECKED_REASON = 'source_version_checked';
export const SUSPENDED_REASON = 'retry_suspended';
const DEFAULT_SOURCE_PROBE_MS = 24 * 60 * 60_000;
// Failure codes that deterministically repeat for identical inputs; the ETL
// skips same-signature retries itself, so a fruitless pass latches immediately.
const deterministicFailureCodes = new Set(['SOURCE_QUALITY_FAILED', 'SNAPSHOT_QUALITY_FAILED']);
// Countries whose synchronization consumes a metered provider quota. A shard
// may declare `quotaProvider` in source-shards.json to extend this; the
// korea-kapt shard does not yet, so KR -> geoapify is kept here on purpose.
const builtinQuotaProviders = { KR: 'geoapify' };

const timestamp = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

// Mirrors nextQuotaReset in server/control/store.ts (read-only reference).
export const nextQuotaResetTime = (period, offsetMinutes, date = new Date()) => {
  const offset = Number(offsetMinutes) || 0;
  const shifted = new Date(date.getTime() + offset * 60_000);
  if (period === 'month') shifted.setUTCMonth(shifted.getUTCMonth() + 1, 1);
  else shifted.setUTCDate(shifted.getUTCDate() + 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offset * 60_000);
};

export const countryFingerprint = ({ importRevision = ADDRESS_IMPORT_REVISION, sourceVersions = [] }) =>
  sha256(JSON.stringify({
    importRevision,
    sourceVersions: [...sourceVersions].map(([shardId, version]) => [String(shardId), String(version || '')])
      .sort(([left], [right]) => left.localeCompare(right))
  }));

export const quotaProviderMap = (shards) => {
  const providers = { ...builtinQuotaProviders };
  for (const shard of shards || []) {
    if (shard.quotaProvider) providers[shard.countryCode] = String(shard.quotaProvider);
  }
  return providers;
};

// Ordering rule: quota-bound countries whose quota window is open come first
// (use-it-or-lose-it, earliest upcoming reset first, i.e. least time left in
// the window); everything else follows by largest absolute deficit.
export const orderRunnable = (entries) => [...entries].sort((left, right) => {
  const leftQuota = left.quotaBound && left.quotaAvailable !== false ? 0 : 1;
  const rightQuota = right.quotaBound && right.quotaAvailable !== false ? 0 : 1;
  if (leftQuota !== rightQuota) return leftQuota - rightQuota;
  if (leftQuota === 0) {
    const leftReset = timestamp(left.quotaResetAt) || Number.MAX_SAFE_INTEGER;
    const rightReset = timestamp(right.quotaResetAt) || Number.MAX_SAFE_INTEGER;
    if (leftReset !== rightReset) return leftReset - rightReset;
  }
  return (right.deficit - left.deficit) || left.countryCode.localeCompare(right.countryCode);
});

export const nextWakeAt = (entries, now = new Date()) => {
  let earliest = 0;
  for (const entry of entries || []) {
    const at = timestamp(entry.nextAttemptAt);
    if (at > now.getTime() && (!earliest || at < earliest)) earliest = at;
  }
  return earliest ? new Date(earliest) : null;
};

// Post-run evaluation. A run is "fruitless" when it produced no net growth and
// every source input (import revision and source versions) is
// identical to the attempt. Successful or deterministically failing fruitless
// runs latch the country as source_limited_cache until an input changes;
// transient failures only back off (capped) so infrastructure issues never
// silence a country permanently.
export const evaluateAttempt = ({
  jobSucceeded,
  netGrowth,
  fingerprintAfter,
  deterministicFailure = false,
  failureCode = null,
  quotaBound = false,
  quotaAvailable = true,
  quotaResetAt = null,
  consecutiveFailures = 0,
  completedAt = new Date().toISOString(),
  backoffBaseMs = 5 * 60_000,
  backoffCapMs = 6 * 60 * 60_000,
  maxConsecutiveFailures = 8,
  maxTimeoutFailures = 2,
  suspendMs = 24 * 60 * 60_000,
  probeIntervalMs = DEFAULT_SOURCE_PROBE_MS
}) => {
  if (quotaBound && !quotaAvailable) {
    return { action: 'waiting_quota', nextAttemptAt: quotaResetAt, consecutiveFailures: 0 };
  }
  if (jobSucceeded && netGrowth > 0) {
    return {
      action: 'checked',
      reason: CHECKED_REASON,
      fingerprint: fingerprintAfter,
      consecutiveFailures: 0,
      nextAttemptAt: new Date(timestamp(completedAt) + Math.max(60_000, probeIntervalMs)).toISOString()
    };
  }
  if (jobSucceeded || deterministicFailure) {
    return { action: 'latch', reason: LATCH_REASON, fingerprint: fingerprintAfter, latchedAt: completedAt };
  }
  const failures = consecutiveFailures + 1;
  const timeoutFailure = ['SYNC_JOB_TIMEOUT', 'SYNC_PROCESS_TIMEOUT', 'SYNC_PROCESS_ABORTED'].includes(String(failureCode || ''));
  if (failures >= Math.max(1, timeoutFailure ? maxTimeoutFailures : maxConsecutiveFailures)) {
    return {
      action: 'suspend',
      reason: SUSPENDED_REASON,
      fingerprint: fingerprintAfter,
      consecutiveFailures: failures,
      failureCode: failureCode || null,
      nextAttemptAt: new Date(timestamp(completedAt) + Math.max(60_000, suspendMs)).toISOString()
    };
  }
  const delay = Math.min(backoffCapMs, backoffBaseMs * 2 ** (failures - 1));
  return {
    action: 'backoff',
    consecutiveFailures: failures,
    failureCode: failureCode || null,
    nextAttemptAt: new Date(timestamp(completedAt) + delay).toISOString()
  };
};

export class QueueStateStore {
  constructor(file) {
    this.file = resolve(file);
  }

  async load() {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8'));
      return state?.schemaVersion === 1 && state.countries ? state : { schemaVersion: 1, countries: {} };
    } catch {
      return { schemaVersion: 1, countries: {} };
    }
  }

  async save(state) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }

  async apply(countryCode, evaluation, evaluatedAt) {
    const state = await this.load();
    if (evaluation.action === 'latch') {
      state.countries[countryCode] = {
        state: 'latched',
        latched: true,
        reason: evaluation.reason || LATCH_REASON,
        fingerprint: evaluation.fingerprint,
        latchedAt: evaluation.latchedAt || evaluatedAt,
        consecutiveFailures: 0,
        nextAttemptAt: null,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'checked') {
      state.countries[countryCode] = {
        state: 'checked',
        latched: false,
        reason: evaluation.reason || CHECKED_REASON,
        fingerprint: evaluation.fingerprint,
        consecutiveFailures: 0,
        nextAttemptAt: evaluation.nextAttemptAt || null,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'suspend') {
      state.countries[countryCode] = {
        state: 'suspended',
        latched: false,
        reason: evaluation.reason || SUSPENDED_REASON,
        fingerprint: evaluation.fingerprint,
        consecutiveFailures: evaluation.consecutiveFailures,
        failureCode: evaluation.failureCode || null,
        nextAttemptAt: evaluation.nextAttemptAt || null,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'backoff') {
      state.countries[countryCode] = {
        state: 'backoff',
        latched: false,
        consecutiveFailures: evaluation.consecutiveFailures,
        failureCode: evaluation.failureCode || null,
        nextAttemptAt: evaluation.nextAttemptAt,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'waiting_quota') {
      delete state.countries[countryCode];
    } else {
      delete state.countries[countryCode];
    }
    await this.save(state);
    return state;
  }

  async clear(countryCodes) {
    const state = await this.load();
    if (countryCodes.some((countryCode) => String(countryCode).toLowerCase() === 'all')) state.countries = {};
    else for (const countryCode of countryCodes) delete state.countries[String(countryCode).toUpperCase()];
    await this.save(state);
    return state;
  }
}

export const createQueueSources = ({
  addressDatabase,
  controlDatabase
}) => {
  const withDatabase = async (database, fallback, reader) => {
    if (!database) return fallback;
    try {
      return await reader(database);
    } catch {
      return fallback;
    }
  };

  const addressFacts = () => withDatabase(addressDatabase, {
    policies: {}, counts: {}, rules: {}, shards: {},
    deficits: { belowTarget: new Set(), belowFloor: new Set() }
  }, async (database) => {
    const policies = {};
    for (const row of (await database.prepare(
      'SELECT country_code,enabled,target_count,updated_at FROM sync_country_policies'
    ).all()).results) {
      policies[String(row.country_code)] = {
        enabled: Boolean(row.enabled),
        targetCount: Number(row.target_count || 0),
        updatedAt: String(row.updated_at || '')
      };
    }
    const counts = {};
    const rules = {};
    const goals = await evaluateCountryGoals(database);
    for (const goal of goals.values()) {
      counts[goal.countryCode] = goal.current;
      rules[goal.countryCode] = goal.rules;
    }
    const shards = {};
    try {
      for (const row of (await database.prepare(
        'SELECT shard_id,country_code,status,source_version,failure_code FROM sync_shard_state'
      ).all()).results) {
        (shards[String(row.country_code)] ||= []).push({
          shardId: String(row.shard_id),
          status: row.status ? String(row.status) : null,
          sourceVersion: row.source_version ? String(row.source_version) : '',
          failureCode: row.failure_code ? String(row.failure_code) : null
        });
      }
    } catch {}
    const deficits = { belowTarget: new Set(), belowFloor: new Set() };
    for (const goal of goals.values()) {
      if (goal.countryCode === 'CN' || !goal.enabled) continue;
      if (!goal.countMet) deficits.belowTarget.add(goal.countryCode);
      if (!goal.coverageMet || !goal.overrideMet) deficits.belowFloor.add(goal.countryCode);
    }
    return { policies, counts, rules, shards, deficits };
  });

  // Availability mirrors ControlStore.acquireCredential filters conservatively:
  // a credential counts as available when enabled, not disabled/needs_review,
  // and any cooldown has expired. When no credential row exists (for example a
  // worker key supplied purely via environment) the quota is treated as
  // available so the country is never starved by missing bookkeeping.
  const quotaStatus = (provider, now = new Date()) => withDatabase(controlDatabase, {
    provider, known: false, available: true, nextResetAt: null
  }, async (database) => {
    const rows = (await database.prepare(`SELECT status,cooldown_until,quota_period,quota_timezone_offset,
        provider_reported_reset_at
      FROM provider_credentials WHERE provider=? AND enabled=1 AND status<>'disabled'`).bind(provider).all()).results;
    if (!rows.length) return { provider, known: false, available: true, nextResetAt: null };
    let available = false;
    let nextResetAt = 0;
    for (const row of rows) {
      const cooldownAt = timestamp(row.cooldown_until);
      const cooling = cooldownAt > now.getTime();
      const status = String(row.status || '');
      if (status === 'healthy' && !cooling) available = true;
      if ((status === 'cooldown' || status === 'quota_exhausted') && cooldownAt && !cooling) available = true;
      const reported = timestamp(row.provider_reported_reset_at);
      const reset = cooling ? cooldownAt : reported > now.getTime()
        ? reported
        : nextQuotaResetTime(String(row.quota_period || 'day'), Number(row.quota_timezone_offset || 0), now).getTime();
      if (!nextResetAt || reset < nextResetAt) nextResetAt = reset;
    }
    return { provider, known: true, available, nextResetAt: nextResetAt ? new Date(nextResetAt).toISOString() : null };
  });

  const chinaPriority = (now = new Date()) => withDatabase(addressDatabase, {
    blocksQueue: false, executionState: null, nextAttemptAt: null
  }, async (database) => {
    const goal = (await evaluateCountryGoals(database)).get('CN');
    if (!goal?.enabled || goal.complete) return { blocksQueue: false, executionState: 'ready', nextAttemptAt: null };
    const runtime = await database.prepare(`SELECT execution_state,next_attempt_at
      FROM sync_country_runtime WHERE country_code='CN'`).first();
    if (!runtime) return { blocksQueue: true, executionState: 'below_target', nextAttemptAt: null };
    const executionState = String(runtime.execution_state || '');
    const nextAttemptAt = runtime.next_attempt_at ? String(runtime.next_attempt_at) : null;
    const due = !nextAttemptAt || timestamp(nextAttemptAt) <= now.getTime();
    return {
      blocksQueue: executionState === 'running' || executionState === 'below_target'
        || (due && ['quota_wait', 'cooldown_wait'].includes(executionState)),
      executionState,
      nextAttemptAt
    };
  });

  return { addressFacts, quotaStatus, chinaPriority };
};

const runningJobCountries = (job, shards) => {
  const countries = new Set();
  if (!job || !Array.isArray(job.shards)) return countries;
  const byShardId = new Map(shards.map((shard) => [shard.id.toLowerCase(), shard.countryCode]));
  for (const value of job.shards) {
    const requested = String(value).trim();
    if (!requested || requested.toLowerCase() === 'all') continue;
    if (/^[a-zA-Z]{2}$/u.test(requested)) countries.add(requested.toUpperCase());
    else if (byShardId.has(requested.toLowerCase())) countries.add(byShardId.get(requested.toLowerCase()));
  }
  return countries;
};

export const computeQueueSnapshot = async ({
  sources,
  catalogShards,
  queueState = { countries: {} },
  runningJob = null,
  importRevision = ADDRESS_IMPORT_REVISION,
  now = new Date()
}) => {
  const facts = await sources.addressFacts();
  const providers = quotaProviderMap(catalogShards);
  const quotaByProvider = {};
  for (const provider of new Set(Object.values(providers))) {
    quotaByProvider[provider] = await sources.quotaStatus(provider, now);
  }
  const shardCountries = new Set((catalogShards || []).map((shard) => shard.countryCode));
  const running = runningJobCountries(runningJob, catalogShards || []);
  const entries = [];
  for (const countryCode of Object.keys(facts.policies).sort()) {
    const policy = facts.policies[countryCode];
    if (countryCode === 'CN' || !policy.enabled) continue;
    const current = facts.counts[countryCode] || 0;
    const target = policy.targetCount;
    const belowTarget = facts.deficits.belowTarget.has(countryCode);
    const belowFloor = facts.deficits.belowFloor.has(countryCode);
    const rules = facts.rules?.[countryCode] || {
      total: { current, target, met: !belowTarget },
      administrativeCoverage: { actual: belowFloor ? 0 : 1, target: 1, met: !belowFloor, covered: 0, total: 0 },
      regionalMinimums: {
        actual: belowFloor ? 0 : 1, target: 1, met: !belowFloor,
        lowest: null, level1: null, level2: null,
        overrides: { satisfied: 0, total: 0, met: true }
      }
    };
    const countryShards = facts.shards[countryCode] || [];
    const fingerprint = countryFingerprint({
      importRevision,
      sourceVersions: countryShards.map((shard) => [shard.shardId, shard.sourceVersion])
    });
    const persisted = queueState.countries?.[countryCode] || {};
    const persistedState = String(persisted.state || (persisted.latched ? 'latched' : ''));
    const persistedFingerprintMatches = persisted.fingerprint === fingerprint;
    const persistedNextAttempt = timestamp(persisted.nextAttemptAt);
    const persistedPauseActive = persistedFingerprintMatches
      && ['latched', 'checked', 'suspended'].includes(persistedState)
      && (!persistedNextAttempt || persistedNextAttempt > now.getTime());
    const provider = providers[countryCode] || null;
    const quota = provider ? quotaByProvider[provider] : null;
    const failedShards = countryShards.filter((shard) => shard.status === 'failed');
    const entry = {
      countryCode,
      deficit: Math.max(0, target - current),
      target,
      current,
      rules,
      unmetRules: [belowTarget ? 'total' : null, belowFloor ? 'coverage' : null].filter(Boolean),
      fingerprint,
      quotaBound: Boolean(provider),
      quotaProvider: provider,
      quotaAvailable: quota ? quota.available : true,
      quotaResetAt: quota?.nextResetAt || null,
      deterministicFailure: failedShards.length > 0
        && failedShards.every((shard) => deterministicFailureCodes.has(shard.failureCode)),
      intervalDays: Number((catalogShards || []).find((shard) => shard.id === countryShards[0]?.shardId)?.intervalDays || 1),
      consecutiveFailures: Number(persisted.consecutiveFailures || 0),
      failureCode: persisted.failureCode || null,
      nextAttemptAt: null,
      reason: null,
      position: null
    };
    if (running.has(countryCode)) {
      entry.state = 'running';
      entry.jobId = runningJob?.id || null;
      entry.jobPhase = runningJob?.phase || null;
      entry.heartbeatAt = runningJob?.heartbeatAt || null;
      entry.deadlineAt = runningJob?.deadlineAt || null;
    } else if (!belowTarget && !belowFloor) {
      entry.state = 'done';
    } else if (persistedPauseActive) {
      entry.state = 'source_limited';
      entry.reason = persisted.reason || (persistedState === 'checked' ? CHECKED_REASON : LATCH_REASON);
      entry.latchedAt = persisted.latchedAt || null;
      entry.nextAttemptAt = persistedNextAttempt ? new Date(persistedNextAttempt).toISOString() : null;
    } else if (!shardCountries.has(countryCode)) {
      entry.state = 'source_limited';
      entry.reason = 'no_source_shard';
    } else if (provider && quota && !quota.available) {
      entry.state = 'waiting_quota';
      entry.nextAttemptAt = quota.nextResetAt;
      entry.reason = provider;
    } else {
      entry.state = 'queued';
      const backoffAt = timestamp(persisted.nextAttemptAt);
      if (backoffAt > now.getTime()) {
        entry.nextAttemptAt = new Date(backoffAt).toISOString();
        entry.reason = 'retry_backoff';
      }
    }
    entries.push(entry);
  }
  const ready = orderRunnable(entries.filter((entry) => entry.state === 'queued' && !entry.nextAttemptAt));
  const delayed = entries.filter((entry) => entry.state === 'queued' && entry.nextAttemptAt)
    .sort((left, right) => timestamp(left.nextAttemptAt) - timestamp(right.nextAttemptAt));
  [...ready, ...delayed].forEach((entry, index) => { entry.position = index + 1; });
  const stateRank = { running: 0, queued: 1, waiting_quota: 2, source_limited: 3, done: 4 };
  entries.sort((left, right) => (stateRank[left.state] - stateRank[right.state])
    || ((left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))
    || left.countryCode.localeCompare(right.countryCode));
  return {
    generatedAt: now.toISOString(),
    job: runningJob ? {
      id: runningJob.id,
      phase: runningJob.phase,
      trigger: runningJob.trigger,
      shards: runningJob.shards,
      startedAt: runningJob.startedAt || null,
      heartbeatAt: runningJob.heartbeatAt || null,
      deadlineAt: runningJob.deadlineAt || null
    } : null,
    entries
  };
};

// Continuous queue engine. While enabled it keeps exactly one country job in
// flight through the shared coordinator whenever any enabled country is below
// its target or floor, is not latched as source-limited, and is not blocked on
// a provider quota. Idle time is spent sleeping until the earliest wake event
// (quota reset or retry backoff) with a periodic rescan as a safety net for
// policy edits made directly in the database.
export const createSyncQueue = ({
  environment = process.env,
  coordinator,
  stateDir,
  addressDatabase,
  controlDatabase,
  sources: providedSources,
  loadCatalog = loadSourceCatalog,
  now = () => new Date(),
  log = console,
  rescanMs = integer(environment.SYNC_QUEUE_RESCAN_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
  cooldownMs = integer(environment.SYNC_QUEUE_COOLDOWN_MS, 10_000, 0, 60 * 60_000),
  backoffBaseMs = integer(environment.SYNC_QUEUE_BACKOFF_BASE_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
  backoffCapMs = integer(environment.SYNC_QUEUE_BACKOFF_CAP_MS, 6 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000)
}) => {
  const store = new QueueStateStore(resolve(stateDir, 'queue-state.json'));
  const sources = providedSources || createQueueSources({
    addressDatabase, controlDatabase
  });
  let catalogPromise;
  const catalogShards = () => (catalogPromise ||= Promise.resolve()
    .then(() => loadCatalog())
    .then((catalog) => catalog.shards));

  const snapshot = async () => computeQueueSnapshot({
    sources,
    catalogShards: await catalogShards(),
    queueState: await store.load(),
    runningJob: coordinator?.currentJob || null,
    now: now()
  });

  let stopped = true;
  let loop = null;
  let wake = null;
  const sleep = (milliseconds) => new Promise((resolveSleep) => {
    const timer = setTimeout(() => { wake = null; resolveSleep(); }, Math.max(1, milliseconds));
    timer.unref?.();
    wake = () => { clearTimeout(timer); wake = null; resolveSleep(); };
  });

  const countryEntry = async (countryCode) => {
    const snap = await snapshot();
    return snap.entries.find((entry) => entry.countryCode === countryCode) || null;
  };

  const applyRecoveredFailures = async () => {
    const recovered = coordinator?.recoveredJobs?.splice(0) || [];
    for (const job of recovered) {
      for (const value of job.shards || []) {
        const countryCode = String(value).toUpperCase();
        if (!/^[A-Z]{2}$/u.test(countryCode)) continue;
        const entry = await countryEntry(countryCode);
        if (!entry || ['done', 'source_limited'].includes(entry.state)) continue;
        const completedAt = job.completedAt || now().toISOString();
        await store.apply(countryCode, evaluateAttempt({
          jobSucceeded: false,
          netGrowth: 0,
          fingerprintAfter: entry.fingerprint,
          failureCode: job.errorCode || 'SYNC_JOB_INTERRUPTED',
          consecutiveFailures: entry.consecutiveFailures,
          completedAt,
          backoffBaseMs,
          backoffCapMs,
          maxConsecutiveFailures: integer(environment.SYNC_QUEUE_MAX_FAILURES, 3, 1, 100),
          maxTimeoutFailures: integer(environment.SYNC_QUEUE_MAX_TIMEOUT_FAILURES, 2, 1, 10),
          suspendMs: integer(environment.SYNC_QUEUE_SUSPEND_MS, 24 * 60 * 60_000, 60_000, 30 * 24 * 60 * 60_000)
        }), completedAt);
      }
    }
  };

  // One pass: pick the next runnable country, run it to completion through the
  // coordinator, evaluate the outcome. Returns milliseconds to sleep before
  // the next pass (0 means continue immediately).
  const tick = async () => {
    const snap = await snapshot();
    if (coordinator.currentJob) {
      await coordinator.waitForIdle();
      return 0;
    }
    const currentTime = now();
    const china = await sources.chinaPriority?.(currentTime);
    if (china?.blocksQueue) {
      log.log?.(`[sync-queue] CN priority state=${china.executionState}`);
      return Math.min(rescanMs, 5_000);
    }
    const pick = snap.entries.find((entry) => entry.state === 'queued'
      && (!entry.nextAttemptAt || timestamp(entry.nextAttemptAt) <= currentTime.getTime()));
    if (!pick) {
      const wakeAt = nextWakeAt(snap.entries, currentTime);
      const delay = wakeAt ? Math.max(1_000, wakeAt.getTime() - currentTime.getTime()) : rescanMs;
      return Math.min(rescanMs, delay);
    }
    log.log?.(`[sync-queue] ${pick.countryCode} start deficit=${pick.deficit} current=${pick.current} target=${pick.target}`);
    const result = await coordinator.trigger('scheduled', { shards: [pick.countryCode] });
    if (!result.accepted) {
      await coordinator.waitForIdle();
      return 0;
    }
    await coordinator.waitForIdle();
    const job = await Promise.resolve(coordinator.getJob?.(result.job.id)).catch(() => null);
    const after = await countryEntry(pick.countryCode);
    const completedAt = now().toISOString();
    const evaluation = evaluateAttempt({
      jobSucceeded: job?.status === 'succeeded',
      netGrowth: (after?.current ?? pick.current) - pick.current,
      fingerprintBefore: pick.fingerprint,
      fingerprintAfter: after?.fingerprint ?? pick.fingerprint,
      deterministicFailure: Boolean(after?.deterministicFailure),
      quotaBound: pick.quotaBound,
      quotaAvailable: after?.quotaAvailable ?? true,
      quotaResetAt: after?.quotaResetAt ?? null,
      consecutiveFailures: pick.consecutiveFailures,
      completedAt,
      backoffBaseMs,
      backoffCapMs,
      maxConsecutiveFailures: integer(environment.SYNC_QUEUE_MAX_FAILURES, 3, 1, 100),
      maxTimeoutFailures: integer(environment.SYNC_QUEUE_MAX_TIMEOUT_FAILURES, 2, 1, 10),
      failureCode: job?.errorCode || null,
      suspendMs: integer(environment.SYNC_QUEUE_SUSPEND_MS, 24 * 60 * 60_000, 60_000, 30 * 24 * 60 * 60_000),
      probeIntervalMs: Math.max(60_000, Number(pick.intervalDays || 1) * 24 * 60 * 60_000)
    });
    await store.apply(pick.countryCode, evaluation, completedAt);
    log.log?.(`[sync-queue] ${pick.countryCode} ${evaluation.action} growth=${(after?.current ?? pick.current) - pick.current}`);
    return cooldownMs;
  };

  const run = async () => {
    await applyRecoveredFailures();
    while (!stopped) {
      let delay = rescanMs;
      try {
        delay = await tick();
      } catch (error) {
        log.error?.('[sync-queue] pass failed', error);
        delay = Math.min(rescanMs, 60_000);
      }
      if (stopped || delay <= 0) continue;
      await sleep(delay);
    }
  };

  const stop = async () => {
    stopped = true;
    wake?.();
    await loop;
    loop = null;
  };

  return {
    snapshot,
    tick,
    store,
    force: async (countryCodes) => {
      await store.clear(countryCodes);
      wake?.();
    },
    poke: () => wake?.(),
    start: () => {
      if (stopped) {
        stopped = false;
        loop = run();
      }
      return () => { void stop(); };
    },
    stop
  };
};
