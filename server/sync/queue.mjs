import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadSourceCatalog, sourceAdapterRevisions } from './source-adapters.mjs';
import { evaluateCountryGoals } from './country-goals.mjs';
import { ADDRESS_IMPORT_REVISION } from './postgres-address-importer.mjs';

export const LATCH_REASON = 'source_limited_cache';
export const CHECKED_REASON = 'source_version_checked';
export const SUSPENDED_REASON = 'retry_suspended';
export const BACKOFF_REASON = 'retry_backoff';
const DEFAULT_SOURCE_PROBE_MS = 24 * 60 * 60_000;
// Failure codes that deterministically repeat for identical inputs; the ETL
// skips same-signature retries itself, so a fruitless pass latches immediately.
const deterministicFailureCodes = new Set(['SOURCE_QUALITY_FAILED', 'SNAPSHOT_QUALITY_FAILED']);
const timeoutFailureCodes = new Set([
  '57014', 'QUERY_CANCELED', 'SYNC_JOB_TIMEOUT', 'SYNC_PROCESS_TIMEOUT', 'SYNC_PROCESS_ABORTED'
]);
// Countries whose synchronization consumes a metered provider quota. A shard
// may declare `quotaProvider` in source-shards.json to extend this; the
// korea-kapt shard does not yet, so KR -> geoapify is kept here on purpose.
const builtinQuotaProviders = { 'korea-kapt-residential': 'geoapify' };
const revisionEmbeddedAdapters = new Set([
  'japan-abr', 'singapore-hdb', 'korea-kapt', 'inegi-residential', 'ethekwini-residential',
  'cape-town-residential', 'taiwan-residential', 'hong-kong-residential', 'mappls-residential',
  'licensed-residential-feed', 'pdok-bag'
]);

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
const quotaPeriodStart = (period, offsetMinutes, date = new Date()) => {
  const shifted = new Date(date.getTime() + (Number(offsetMinutes) || 0) * 60_000).toISOString();
  return period === 'month' ? shifted.slice(0, 7) : shifted.slice(0, 10);
};

const sortedPairs = (pairs) => [...pairs].map(([key, value]) => [String(key), String(value || '')])
  .sort(([left], [right]) => left.localeCompare(right));

export const countryFingerprint = ({ adapterRevisions = [], sourceVersions = [] }) =>
  sha256(JSON.stringify({
    adapterRevisions: sortedPairs(adapterRevisions),
    sourceVersions: sortedPairs(sourceVersions)
  }));

export const legacyCountryFingerprint = ({ importRevision = ADDRESS_IMPORT_REVISION, sourceVersions = [] }) =>
  sha256(JSON.stringify({ importRevision, sourceVersions: sortedPairs(sourceVersions) }));

const deprecatedCountryFingerprint = ({
  importRevision = ADDRESS_IMPORT_REVISION,
  policyUpdatedAt = '',
  nodeTargetsUpdatedAt = '',
  catalogVersion = '',
  adapterRevisions = [],
  sourceVersions = []
}) => sha256(JSON.stringify({
  importRevision,
  policyUpdatedAt: String(policyUpdatedAt || ''),
  nodeTargetsUpdatedAt: String(nodeTargetsUpdatedAt || ''),
  catalogVersion: String(catalogVersion || ''),
  adapterRevisions: sortedPairs(adapterRevisions),
  sourceVersions: sortedPairs(sourceVersions)
}));

const retryFingerprint = (sourceFingerprint, credentialRevision = '') =>
  sha256(JSON.stringify({ sourceFingerprint, credentialRevision: String(credentialRevision || '') }));

export const quotaProviderMap = (shards) => {
  const providers = { ...builtinQuotaProviders };
  for (const shard of shards || []) {
    if (shard.quotaProvider) providers[shard.id] = String(shard.quotaProvider);
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
  const lastDispatched = timestamp(left.lastDispatchedAt) - timestamp(right.lastDispatchedAt);
  return lastDispatched || (right.deficit - left.deficit) || left.countryCode.localeCompare(right.countryCode);
});

export const estimateDuration = (samples, minimumSamples = 3) => {
  const values = (samples || []).map(Number).filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (values.length < minimumSamples) return null;
  const percentile = (value) => values[Math.max(0, Math.ceil(values.length * value) - 1)];
  return { sampleCount: values.length, medianMs: percentile(0.5), p80Ms: percentile(0.8) };
};

const goalDeficit = (rules) => {
  if (!rules) return Number.MAX_SAFE_INTEGER;
  const required = (summary, target = 1) => {
    if (!summary) return 0;
    return Math.max(0, Math.ceil(Number(summary.total || 0) * Number(target || 0)) - Number(summary.qualified || 0));
  };
  const coverage = rules.administrativeCoverage || {};
  const regional = rules.regionalMinimums || {};
  const total = rules.total || {};
  return Math.max(0, Number(total.target || 0) - Number(total.current || 0))
    + Math.max(0, Math.ceil(Number(coverage.total || 0) * Number(coverage.target || 0)) - Number(coverage.covered || 0))
    + required(regional.lowest, regional.target)
    + required(regional.level1, regional.target)
    + required(regional.level2, regional.target)
    + Math.max(0, Number(regional.overrides?.total || 0) - Number(regional.overrides?.satisfied || 0));
};

export const goalProgress = (rules) => ({
  deficit: goalDeficit(rules),
  total: Number(rules?.total?.current || 0),
  covered: Number(rules?.administrativeCoverage?.covered || 0),
  lowestQualified: Number(rules?.regionalMinimums?.lowest?.qualified || 0),
  level1Qualified: Number(rules?.regionalMinimums?.level1?.qualified || 0),
  level2Qualified: Number(rules?.regionalMinimums?.level2?.qualified || 0),
  overridesSatisfied: Number(rules?.regionalMinimums?.overrides?.satisfied || 0)
});

export const nextWakeAt = (entries, now = new Date()) => {
  let earliest = 0;
  for (const entry of entries || []) {
    const at = timestamp(entry.nextAttemptAt);
    if (at > now.getTime() && (!earliest || at < earliest)) earliest = at;
  }
  return earliest ? new Date(earliest) : null;
};

// A successful identical-input run with no goal progress exhausts that source.
// Transient failures back off, then stop for the same effective inputs after a
// bounded number of attempts.
export const evaluateAttempt = ({
  jobSucceeded,
  netGrowth,
  goalDeficitBefore = null,
  goalDeficitAfter = null,
  fingerprintAfter,
  failureFingerprintAfter = fingerprintAfter,
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
  probeIntervalMs = DEFAULT_SOURCE_PROBE_MS
}) => {
  if (quotaBound && !quotaAvailable) {
    return { action: 'waiting_quota', nextAttemptAt: quotaResetAt, consecutiveFailures: 0 };
  }
  const progressed = netGrowth > 0 || (goalDeficitBefore != null && goalDeficitAfter != null
    && Number(goalDeficitAfter) < Number(goalDeficitBefore));
  if (jobSucceeded && progressed) {
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
  const timeoutFailure = timeoutFailureCodes.has(String(failureCode || '').toUpperCase());
  if (failures >= Math.max(1, timeoutFailure ? maxTimeoutFailures : maxConsecutiveFailures)) {
    return {
      action: 'suspend',
      reason: SUSPENDED_REASON,
      fingerprint: failureFingerprintAfter,
      consecutiveFailures: failures,
      failureCode: failureCode || null,
      nextAttemptAt: null
    };
  }
  const delay = Math.min(backoffCapMs, backoffBaseMs * 2 ** (failures - 1));
  return {
    action: 'backoff',
    fingerprint: failureFingerprintAfter,
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

  async apply(countryCode, evaluation, evaluatedAt, shardId = null) {
    const state = await this.load();
    let target;
    if (shardId) {
      const country = state.countries[countryCode] ||= { shards: {} };
      country.shards ||= {};
      target = country.shards;
    } else {
      target = state.countries;
    }
    const key = shardId || countryCode;
    if (evaluation.action === 'latch') {
      target[key] = {
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
      target[key] = {
        state: 'checked',
        latched: false,
        reason: evaluation.reason || CHECKED_REASON,
        fingerprint: evaluation.fingerprint,
        consecutiveFailures: 0,
        nextAttemptAt: evaluation.nextAttemptAt || null,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'suspend') {
      target[key] = {
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
      target[key] = {
        state: 'backoff',
        latched: false,
        fingerprint: evaluation.fingerprint || null,
        consecutiveFailures: evaluation.consecutiveFailures,
        failureCode: evaluation.failureCode || null,
        nextAttemptAt: evaluation.nextAttemptAt,
        updatedAt: evaluatedAt
      };
    } else if (evaluation.action === 'waiting_quota') {
      delete target[key];
    } else {
      delete target[key];
    }
    if (shardId) {
      const country = state.countries[countryCode];
      country.updatedAt = evaluatedAt;
      if (!Object.keys(country.shards || {}).length) delete state.countries[countryCode];
    }
    await this.save(state);
    return state;
  }

  async clear(countryCodes) {
    const state = await this.load();
    if (countryCodes.some((countryCode) => String(countryCode).toLowerCase() === 'all')) state.countries = {};
    else for (const value of countryCodes) {
      const identifier = String(value);
      if (/^[a-z]{2}$/iu.test(identifier)) delete state.countries[identifier.toUpperCase()];
      else for (const [countryCode, country] of Object.entries(state.countries)) {
        delete country.shards?.[identifier];
        if (!Object.keys(country.shards || {}).length) delete state.countries[countryCode];
      }
    }
    await this.save(state);
    return state;
  }

  async migrateCountry(countryCode, shardId, entry, migratedAt) {
    const state = await this.load();
    state.countries[countryCode] = {
      shards: { [shardId]: entry },
      migratedAt,
      updatedAt: migratedAt
    };
    await this.save(state);
  }
}

export class PostgresQueueStateStore {
  constructor(database, legacyFile = null) {
    this.database = database;
    this.legacyFile = legacyFile ? resolve(legacyFile) : null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    if (!this.legacyFile) {
      this.initialized = true;
      return;
    }
    const total = Number(await this.database.prepare('SELECT COUNT(*) AS total FROM sync_source_execution_state').first('total') || 0);
    if (total) {
      await rm(this.legacyFile, { force: true });
      this.initialized = true;
      return;
    }
    let legacy;
    try {
      legacy = JSON.parse(await readFile(this.legacyFile, 'utf8'));
    } catch {
      this.initialized = true;
      return;
    }
    for (const [countryCode, country] of Object.entries(legacy?.countries || {})) {
      const shards = country?.shards || { [countryCode]: country };
      for (const [sourceId, entry] of Object.entries(shards)) {
        if (!entry || typeof entry !== 'object') continue;
        await this.writeEntry(countryCode, sourceId, entry, entry.updatedAt || new Date().toISOString());
      }
    }
    await rm(this.legacyFile, { force: true });
    this.initialized = true;
  }

  async load() {
    await this.initialize();
    const rows = (await this.database.prepare(`SELECT country_code,source_id,state,reason,source_fingerprint,
      failure_fingerprint,consecutive_failures,failure_code,next_attempt_at,exhausted_at,updated_at
      FROM sync_source_execution_state`).all()).results;
    const state = { schemaVersion: 1, countries: {} };
    for (const row of rows) {
      const country = state.countries[row.country_code] ||= { shards: {}, updatedAt: row.updated_at };
      const savedState = row.state === 'exhausted' ? 'latched' : row.state;
      country.shards[row.source_id] = {
        state: savedState,
        latched: savedState === 'latched',
        reason: row.reason || null,
        fingerprint: ['suspended', 'backoff'].includes(savedState) ? row.failure_fingerprint : row.source_fingerprint,
        latchedAt: row.exhausted_at || null,
        consecutiveFailures: Number(row.consecutive_failures || 0),
        failureCode: row.failure_code || null,
        nextAttemptAt: row.next_attempt_at || null,
        updatedAt: row.updated_at
      };
      if (timestamp(row.updated_at) > timestamp(country.updatedAt)) country.updatedAt = row.updated_at;
    }
    return state;
  }

  async writeEntry(countryCode, sourceId, entry, evaluatedAt) {
    const savedState = String(entry.state || (entry.latched ? 'latched' : ''));
    if (!['latched', 'checked', 'backoff', 'suspended'].includes(savedState)) return;
    const databaseState = savedState === 'latched' ? 'exhausted' : savedState;
    const failureState = ['backoff', 'suspended'].includes(savedState);
    await this.database.prepare(`INSERT INTO sync_source_execution_state(
      country_code,source_id,state,reason,source_fingerprint,failure_fingerprint,consecutive_failures,
      failure_code,next_attempt_at,exhausted_at,last_attempt_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(country_code,source_id) DO UPDATE SET
      state=excluded.state,reason=excluded.reason,source_fingerprint=excluded.source_fingerprint,
      failure_fingerprint=excluded.failure_fingerprint,consecutive_failures=excluded.consecutive_failures,
      failure_code=excluded.failure_code,next_attempt_at=excluded.next_attempt_at,
      exhausted_at=excluded.exhausted_at,last_attempt_at=excluded.last_attempt_at,updated_at=excluded.updated_at`)
      .bind(
        countryCode, sourceId, databaseState, entry.reason || null,
        failureState ? null : entry.fingerprint || null,
        failureState ? entry.fingerprint || null : null,
        Number(entry.consecutiveFailures || 0), entry.failureCode || null, entry.nextAttemptAt || null,
        savedState === 'latched' ? entry.latchedAt || evaluatedAt : null, evaluatedAt, evaluatedAt
      ).run();
  }

  async apply(countryCode, evaluation, evaluatedAt, shardId = null) {
    await this.initialize();
    const sourceId = shardId || countryCode;
    if (evaluation.action === 'waiting_quota' || !['latch', 'checked', 'suspend', 'backoff'].includes(evaluation.action)) {
      await this.database.prepare('DELETE FROM sync_source_execution_state WHERE country_code=? AND source_id=?')
        .bind(countryCode, sourceId).run();
      return this.load();
    }
    const state = evaluation.action === 'latch' ? 'latched'
      : evaluation.action === 'suspend' ? 'suspended' : evaluation.action;
    await this.writeEntry(countryCode, sourceId, {
      state,
      reason: evaluation.reason || (state === 'latched' ? LATCH_REASON
        : state === 'checked' ? CHECKED_REASON : state === 'backoff' ? BACKOFF_REASON : SUSPENDED_REASON),
      fingerprint: evaluation.fingerprint || null,
      latchedAt: evaluation.latchedAt || null,
      consecutiveFailures: evaluation.consecutiveFailures || 0,
      failureCode: evaluation.failureCode || null,
      nextAttemptAt: evaluation.nextAttemptAt || null
    }, evaluatedAt);
    return this.load();
  }

  async clear(countryCodes) {
    await this.initialize();
    if (countryCodes.some((countryCode) => String(countryCode).toLowerCase() === 'all')) {
      await this.database.prepare('DELETE FROM sync_source_execution_state').run();
    } else {
      const countries = [...new Set(countryCodes.map(String).filter((value) => /^[a-z]{2}$/iu.test(value)).map((value) => value.toUpperCase()))];
      const sources = [...new Set(countryCodes.map(String).filter((value) => !/^[a-z]{2}$/iu.test(value)))];
      if (countries.length) await this.database.prepare(`DELETE FROM sync_source_execution_state
        WHERE country_code IN (${countries.map(() => '?').join(',')})`).bind(...countries).run();
      if (sources.length) await this.database.prepare(`DELETE FROM sync_source_execution_state
        WHERE source_id IN (${sources.map(() => '?').join(',')})`).bind(...sources).run();
    }
    return this.load();
  }

  async migrateCountry(countryCode, shardId, entry, migratedAt) {
    await this.initialize();
    await this.writeEntry(countryCode, shardId, entry, migratedAt);
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
    policies: {}, counts: {}, rules: {}, shards: {}, durationSamples: { countries: {}, sources: {} },
    nodeTargetsUpdatedAt: {}, catalogVersion: '',
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
        'SELECT shard_id,country_code,status,source_version,failure_code,updated_at FROM sync_shard_state'
      ).all()).results) {
        (shards[String(row.country_code)] ||= []).push({
          shardId: String(row.shard_id),
          status: row.status ? String(row.status) : null,
          sourceVersion: row.source_version ? String(row.source_version) : '',
          failureCode: row.failure_code ? String(row.failure_code) : null,
          updatedAt: row.updated_at ? String(row.updated_at) : ''
        });
      }
    } catch {}
    const nodeTargetsUpdatedAt = {};
    try {
      for (const row of (await database.prepare(`SELECT country_code,MAX(updated_at) AS updated_at
        FROM sync_node_overrides GROUP BY country_code`).all()).results) {
        nodeTargetsUpdatedAt[String(row.country_code)] = String(row.updated_at || '');
      }
    } catch {}
    let catalogVersion = '';
    try {
      const rows = (await database.prepare(`SELECT source,source_version,source_checksum
        FROM catalog_metadata ORDER BY source`).all()).results;
      catalogVersion = rows.map((row) => [String(row.source), String(row.source_version || ''), String(row.source_checksum || '')])
        .map((row) => row.join(':')).join('|');
    } catch {}
    const durationSamples = { countries: {}, sources: {} };
    try {
      const rows = (await database.prepare(`SELECT history.country_code,history.source_id,history.started_at,
          history.completed_at,run.target_json
        FROM sync_run_countries history JOIN sync_runs run ON run.id=history.run_id
        WHERE history.status IN ('succeeded','failed','paused_quota') AND history.source_id<>''
          AND history.started_at IS NOT NULL AND history.completed_at IS NOT NULL
        ORDER BY history.completed_at DESC LIMIT 1000`).all()).results;
      for (const row of rows) {
        let target = {};
        try { target = JSON.parse(String(row.target_json || '{}')); } catch {}
        const shards = Array.isArray(target.shards) ? target.shards.map(String) : [];
        if (shards.length !== 1 || shards[0].toLowerCase() === 'all' || shards[0] !== String(row.source_id)) continue;
        const duration = timestamp(row.completed_at) - timestamp(row.started_at);
        if (duration <= 0) continue;
        (durationSamples.countries[String(row.country_code)] ||= []).push(duration);
        (durationSamples.sources[String(row.source_id)] ||= []).push(duration);
      }
    } catch {}
    const deficits = { belowTarget: new Set(), belowFloor: new Set() };
    for (const goal of goals.values()) {
      if (goal.countryCode === 'CN' || !goal.enabled) continue;
      if (!goal.countMet) deficits.belowTarget.add(goal.countryCode);
      if (!goal.coverageMet || !goal.overrideMet) deficits.belowFloor.add(goal.countryCode);
    }
    return { policies, counts, rules, shards, nodeTargetsUpdatedAt, catalogVersion, durationSamples, deficits };
  });

  // Availability mirrors ControlStore.acquireCredential filters conservatively:
  // a credential counts as available when enabled, not disabled/needs_review,
  // and any cooldown has expired. When no credential row exists (for example a
  // worker key supplied purely via environment) the quota is treated as
  // available so the country is never starved by missing bookkeeping.
  const quotaStatus = (provider, now = new Date()) => withDatabase(controlDatabase, {
    provider, known: false, available: true, nextResetAt: null, waitState: null, revision: ''
  }, async (database) => {
    const rows = (await database.prepare(`SELECT id,status,cooldown_until,quota_period,quota_timezone_offset,
        provider_reported_reset_at,updated_at
      FROM provider_credentials WHERE provider=? AND enabled=1 AND status<>'disabled'`).bind(provider).all()).results;
    if (!rows.length) return {
      provider,
      known: false,
      available: provider !== 'mappls',
      nextResetAt: null,
      waitState: provider === 'mappls' ? 'blocked' : null,
      revision: ''
    };
    let available = false;
    let nextResetAt = 0;
    let waitState = null;
    const revisions = [];
    for (const row of rows) {
      if (String(row.status || '') === 'needs_review') continue;
      const cooldownAt = timestamp(row.cooldown_until);
      const cooling = cooldownAt > now.getTime();
      const status = String(row.status || '');
      const windows = (await database.prepare(`SELECT quota_window.service,quota_window.scope_id,quota_window.period,
        quota_window.limit_count,quota_window.timezone_offset,quota_window.updated_at,
        observation.used_count,observation.limit_count AS observed_limit,observation.reset_at,observation.observed_at
        FROM provider_quota_windows quota_window LEFT JOIN provider_quota_observations observation
          ON observation.credential_id=quota_window.credential_id AND observation.service=quota_window.service
            AND observation.period=quota_window.period
        WHERE quota_window.credential_id=? AND quota_window.enabled=1`).bind(row.id).all()).results;
      let quotaBlockedUntil = 0;
      for (const window of windows) {
        const period = String(window.period || 'day');
        const offset = Number(window.timezone_offset || 0);
        const localUsed = Number(await database.prepare(`SELECT COALESCE(SUM(usage.accepted_count+usage.rejected_count),0) AS total
          FROM provider_credentials credential JOIN provider_usage_periods usage ON usage.credential_id=credential.id
          WHERE credential.quota_scope_id=? AND credential.quota_service=? AND usage.period_start=?`)
          .bind(window.scope_id, window.service, quotaPeriodStart(period, offset, now)).first('total') || 0);
        const observed = window.observed_at && (!window.reset_at || timestamp(window.reset_at) > now.getTime());
        const used = Math.max(localUsed, observed ? Number(window.used_count || 0) : 0);
        const limit = observed && window.observed_limit !== null ? Number(window.observed_limit) : Number(window.limit_count);
        if (used >= limit) {
          const reset = observed && timestamp(window.reset_at) > now.getTime()
            ? timestamp(window.reset_at) : nextQuotaResetTime(period, offset, now).getTime();
          quotaBlockedUntil = Math.max(quotaBlockedUntil, reset);
        }
        revisions.push([row.id, window.service, period, used, limit, window.updated_at, window.observed_at]);
      }
      const blockedUntil = Math.max(cooling ? cooldownAt : 0, quotaBlockedUntil);
      if (!blockedUntil && (status === 'healthy' || ['cooldown', 'quota_exhausted'].includes(status))) {
        available = true;
        continue;
      }
      if (blockedUntil && (!nextResetAt || blockedUntil < nextResetAt)) {
        nextResetAt = blockedUntil;
        waitState = quotaBlockedUntil >= (cooling ? cooldownAt : 0) ? 'quota_wait' : 'cooldown_wait';
      }
    }
    return {
      provider,
      known: true,
      available,
      nextResetAt: nextResetAt ? new Date(nextResetAt).toISOString() : null,
      waitState,
      revision: sha256(JSON.stringify([
        ...rows.map((row) => [row.id, row.status, row.updated_at]), ...revisions
      ].sort()))
    };
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
    const storedShards = facts.shards[countryCode] || [];
    const storedById = new Map(storedShards.map((shard) => [shard.shardId, shard]));
    const configuredShards = (catalogShards || []).filter((shard) => shard.countryCode === countryCode);
    const persisted = queueState.countries?.[countryCode] || {};
    const sourceEntries = configuredShards.map((shard) => {
      const stored = storedById.get(shard.id) || {};
      const sourceVersion = stored.sourceVersion || shard.source?.sourceVersion || '';
      const adapterRevision = sourceAdapterRevisions[shard.source?.adapter] || '';
      const provider = providers[shard.id] || null;
      const quota = provider ? quotaByProvider[provider] : null;
      const sourceFingerprint = countryFingerprint({
        adapterRevisions: [[shard.id, adapterRevision]],
        sourceVersions: [[shard.id, sourceVersion]]
      });
      const failureFingerprint = retryFingerprint(sourceFingerprint, quota?.revision || '');
      const saved = persisted.shards?.[shard.id] || {};
      const savedState = String(saved.state || (saved.latched ? 'latched' : ''));
      const expectedFingerprint = ['suspended', 'backoff'].includes(savedState)
        ? failureFingerprint
        : sourceFingerprint;
      const matches = saved.fingerprint === expectedFingerprint;
      const nextAttempt = timestamp(saved.nextAttemptAt);
      const paused = matches && ['latched', 'checked', 'suspended'].includes(savedState)
        && (!nextAttempt || nextAttempt > now.getTime());
      return {
        shard,
        stored,
        saved,
        savedState,
        matches,
        paused,
        nextAttempt,
        provider,
        quota,
        sourceFingerprint,
        failureFingerprint
      };
    });
    const sourceVersions = sourceEntries.map(({ shard, stored }) => [shard.id, stored.sourceVersion || shard.source?.sourceVersion || '']);
    const adapterRevisions = sourceEntries.map(({ shard }) => [shard.id, sourceAdapterRevisions[shard.source?.adapter] || '']);
    const fingerprint = countryFingerprint({ adapterRevisions, sourceVersions });
    const legacyFingerprint = legacyCountryFingerprint({ importRevision, sourceVersions });
    const deprecatedFingerprint = deprecatedCountryFingerprint({
      importRevision,
      policyUpdatedAt: policy.updatedAt,
      nodeTargetsUpdatedAt: facts.nodeTargetsUpdatedAt?.[countryCode] || '',
      catalogVersion: facts.catalogVersion || '',
      adapterRevisions: storedShards.map((shard) => [
        shard.shardId,
        sourceAdapterRevisions[configuredShards.find((candidate) => candidate.id === shard.shardId)?.source?.adapter] || ''
      ]),
      sourceVersions: storedShards.map((shard) => [shard.shardId, shard.sourceVersion])
    });
    const persistedState = String(persisted.state || (persisted.latched ? 'latched' : ''));
    const persistedNextAttempt = timestamp(persisted.nextAttemptAt);
    const legacyFingerprintMatches = !persisted.shards
      && [legacyFingerprint, deprecatedFingerprint].includes(persisted.fingerprint)
      && ['latched', 'checked', 'suspended'].includes(persistedState)
      && (!persistedNextAttempt || persistedNextAttempt > now.getTime());
    const migrationCandidates = sourceEntries.filter(({ shard, stored }) => {
      if (!stored.sourceVersion) return false;
      const adapter = shard.source?.adapter;
      const revision = sourceAdapterRevisions[adapter] || '';
      return !revisionEmbeddedAdapters.has(adapter) || !revision || stored.sourceVersion.includes(revision);
    });
    const migrationSource = legacyFingerprintMatches && migrationCandidates.length
      ? [...migrationCandidates].sort((left, right) => timestamp(right.stored.updatedAt) - timestamp(left.stored.updatedAt))[0]
      : null;
    const legacyPauseActive = Boolean(migrationSource);
    const runnableSources = sourceEntries.filter((source) => !source.paused)
      .sort((left, right) => {
        const quotaOrder = Number(Boolean(left.quota && !left.quota.available))
          - Number(Boolean(right.quota && !right.quota.available));
        if (quotaOrder) return quotaOrder;
        const meteredOrder = Number(!left.provider) - Number(!right.provider);
        if (meteredOrder) return meteredOrder;
        const leftAt = left.matches ? left.nextAttempt : 0;
        const rightAt = right.matches ? right.nextAttempt : 0;
        return (leftAt > now.getTime()) - (rightAt > now.getTime()) || leftAt - rightAt;
      });
    const selectedSource = runnableSources[0] || null;
    const provider = selectedSource?.provider || null;
    const quota = selectedSource?.quota || null;
    const delayedUntil = selectedSource?.matches && selectedSource.nextAttempt > now.getTime()
      ? selectedSource.nextAttempt
      : 0;
    const pausedWakeAt = sourceEntries.map((source) => source.paused ? source.nextAttempt : 0)
      .filter((value) => value > now.getTime()).sort((left, right) => left - right)[0] || 0;
    const entry = {
      countryCode,
      deficit: Math.max(0, target - current),
      target,
      current,
      rules,
      unmetRules: [rules.total?.met ? null : 'total',
        rules.administrativeCoverage?.met ? null : 'administrative_coverage',
        rules.regionalMinimums?.met ? null : 'regional_minimums'].filter(Boolean),
      fingerprint,
      legacyMigration: migrationSource ? {
        shardId: migrationSource.shard.id,
        entry: {
          state: persistedState,
          latched: persistedState === 'latched',
          reason: persisted.reason || (persistedState === 'checked' ? CHECKED_REASON : LATCH_REASON),
          fingerprint: persistedState === 'suspended'
            ? migrationSource.failureFingerprint
            : migrationSource.sourceFingerprint,
          latchedAt: persisted.latchedAt || null,
          consecutiveFailures: Number(persisted.consecutiveFailures || 0),
          failureCode: persisted.failureCode || null,
          nextAttemptAt: persistedState === 'suspended' ? null : persisted.nextAttemptAt || null,
          updatedAt: persisted.updatedAt || now.toISOString()
        }
      } : null,
      runnableShardId: selectedSource?.shard.id || null,
      sourceFingerprints: Object.fromEntries(sourceEntries.map((source) => [source.shard.id, source.sourceFingerprint])),
      failureFingerprints: Object.fromEntries(sourceEntries.map((source) => [source.shard.id, source.failureFingerprint])),
      quotaBound: Boolean(provider),
      quotaProvider: provider,
      quotaAvailable: quota ? quota.available : true,
      quotaResetAt: quota?.nextResetAt || null,
      intervalDays: Number(selectedSource?.shard.intervalDays || 1),
      consecutiveFailures: selectedSource?.matches ? Number(selectedSource.saved.consecutiveFailures || 0) : 0,
      failureCode: selectedSource?.matches ? selectedSource.saved.failureCode || null : null,
      nextAttemptAt: null,
      reason: null,
      lastDispatchedAt: persisted.updatedAt || null,
      position: null
    };
    const sourceDurations = facts.durationSamples?.sources?.[selectedSource?.shard.id] || [];
    const countryDurations = facts.durationSamples?.countries?.[countryCode] || [];
    entry.eta = estimateDuration(sourceDurations) || estimateDuration(countryDurations);
    if (running.has(countryCode)) {
      entry.state = 'running';
      entry.jobId = runningJob?.id || null;
      entry.jobPhase = runningJob?.phase || null;
      entry.heartbeatAt = runningJob?.heartbeatAt || null;
      entry.deadlineAt = runningJob?.deadlineAt || null;
      if (entry.eta && runningJob?.startedAt) {
        entry.eta = {
          ...entry.eta,
          estimatedCompletionAt: new Date(timestamp(runningJob.startedAt) + entry.eta.p80Ms).toISOString(),
          remainingMedianMs: Math.max(0, timestamp(runningJob.startedAt) + entry.eta.medianMs - now.getTime()),
          remainingP80Ms: Math.max(0, timestamp(runningJob.startedAt) + entry.eta.p80Ms - now.getTime())
        };
      }
    } else if (!belowTarget && !belowFloor) {
      entry.state = 'done';
    } else if (legacyPauseActive) {
      entry.state = persistedState === 'checked' ? 'scheduled_wait'
        : persistedState === 'suspended' ? 'suspended' : 'source_limited';
      entry.reason = persisted.reason || (persistedState === 'checked' ? CHECKED_REASON : LATCH_REASON);
      entry.latchedAt = persisted.latchedAt || null;
      entry.nextAttemptAt = persistedNextAttempt ? new Date(persistedNextAttempt).toISOString() : null;
    } else if (!configuredShards.length || !shardCountries.has(countryCode)) {
      entry.state = 'no_source';
      entry.reason = 'no_source_shard';
    } else if (!selectedSource) {
      const suspended = sourceEntries.find((source) => source.savedState === 'suspended');
      const checked = sourceEntries.find((source) => source.savedState === 'checked');
      const exhausted = sourceEntries.find((source) => source.savedState === 'latched');
      entry.state = suspended ? 'suspended' : checked ? 'scheduled_wait' : 'source_limited';
      entry.reason = suspended?.saved.reason || checked?.saved.reason || exhausted?.saved.reason || LATCH_REASON;
      entry.nextAttemptAt = pausedWakeAt ? new Date(pausedWakeAt).toISOString() : null;
    } else if (provider && quota && !quota.available) {
      entry.state = quota.waitState === 'cooldown_wait' ? 'cooldown_wait' : 'quota_wait';
      entry.nextAttemptAt = quota.nextResetAt;
      entry.reason = provider;
    } else if (delayedUntil) {
      entry.state = 'retry_wait';
      entry.nextAttemptAt = new Date(delayedUntil).toISOString();
      entry.reason = BACKOFF_REASON;
    } else {
      entry.state = 'queued';
    }
    entries.push(entry);
  }
  const ready = orderRunnable(entries.filter((entry) => entry.state === 'queued'));
  ready.forEach((entry, index) => { entry.position = index + 1; });
  const stateRank = {
    running: 0, queued: 1, retry_wait: 2, cooldown_wait: 3, quota_wait: 4, scheduled_wait: 5,
    source_limited: 6, suspended: 7, no_source: 8, done: 9
  };
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

// Continuous queue engine. It keeps one runnable source shard in flight while
// preserving independent exhausted and retry states for every source.
export const createSyncQueue = ({
  environment = process.env,
  coordinator,
  stateDir,
  addressDatabase,
  controlDatabase,
  history = null,
  sources: providedSources,
  loadCatalog = loadSourceCatalog,
  now = () => new Date(),
  log = console,
  rescanMs = integer(environment.SYNC_QUEUE_RESCAN_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
  cooldownMs = integer(environment.SYNC_QUEUE_COOLDOWN_MS, 10_000, 0, 60 * 60_000),
  backoffBaseMs = integer(environment.SYNC_QUEUE_BACKOFF_BASE_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
  backoffCapMs = integer(environment.SYNC_QUEUE_BACKOFF_CAP_MS, 6 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000)
}) => {
  const legacyStateFile = resolve(stateDir, 'queue-state.json');
  const store = addressDatabase
    ? new PostgresQueueStateStore(addressDatabase, legacyStateFile)
    : new QueueStateStore(legacyStateFile);
  const sources = providedSources || createQueueSources({
    addressDatabase, controlDatabase
  });
  let catalogPromise;
  const catalogShards = () => (catalogPromise ||= Promise.resolve()
    .then(() => loadCatalog())
    .then((catalog) => catalog.shards));

  const queueSnapshot = async () => {
    const configured = await catalogShards();
    const build = async () => computeQueueSnapshot({
      sources,
      catalogShards: configured,
      queueState: await store.load(),
      runningJob: coordinator?.currentJob || null,
      now: now()
    });
    let result = await build();
    const migrations = result.entries.filter((entry) => entry.legacyMigration);
    for (const entry of migrations) {
      await store.migrateCountry(
        entry.countryCode,
        entry.legacyMigration.shardId,
        entry.legacyMigration.entry,
        now().toISOString()
      );
    }
    if (migrations.length) result = await build();
    return result;
  };
  const snapshot = async () => {
    const result = await queueSnapshot();
    return {
      ...result,
      entries: result.entries.map(({ sourceFingerprints, failureFingerprints, legacyMigration, ...entry }) => entry)
    };
  };

  let stopped = true;
  let loop = null;
  let wake = null;
  const sleep = (milliseconds) => new Promise((resolveSleep) => {
    const timer = setTimeout(() => { wake = null; resolveSleep(); }, Math.max(1, milliseconds));
    timer.unref?.();
    wake = () => { clearTimeout(timer); wake = null; resolveSleep(); };
  });

  const countryEntry = async (countryCode) => {
    const snap = await queueSnapshot();
    return snap.entries.find((entry) => entry.countryCode === countryCode) || null;
  };

  const applyRecoveredFailures = async () => {
    const recovered = coordinator?.recoveredJobs?.splice(0) || [];
    const configured = await catalogShards();
    const byShard = new Map(configured.map((shard) => [shard.id.toLowerCase(), shard]));
    for (const job of recovered) {
      for (const value of job.shards || []) {
        const requested = String(value);
        const configuredShard = byShard.get(requested.toLowerCase());
        const countryCode = configuredShard?.countryCode || requested.toUpperCase();
        if (!/^[A-Z]{2}$/u.test(countryCode)) continue;
        const entry = await countryEntry(countryCode);
        if (!entry || ['done', 'source_limited', 'suspended', 'no_source'].includes(entry.state)) continue;
        const shardId = configuredShard?.id || entry.runnableShardId;
        if (!shardId) continue;
        const completedAt = job.completedAt || now().toISOString();
        await store.apply(countryCode, evaluateAttempt({
          jobSucceeded: false,
          netGrowth: 0,
          fingerprintAfter: entry.sourceFingerprints[shardId],
          failureFingerprintAfter: entry.failureFingerprints[shardId],
          failureCode: job.errorCode || 'SYNC_JOB_INTERRUPTED',
          consecutiveFailures: entry.consecutiveFailures,
          completedAt,
          backoffBaseMs,
          backoffCapMs,
          maxConsecutiveFailures: integer(environment.SYNC_QUEUE_MAX_FAILURES, 3, 1, 100),
          maxTimeoutFailures: integer(environment.SYNC_QUEUE_MAX_TIMEOUT_FAILURES, 2, 1, 10)
        }), completedAt, shardId);
      }
    }
  };

  // One pass: pick the next runnable country, run it to completion through the
  // coordinator, evaluate the outcome. Returns milliseconds to sleep before
  // the next pass (0 means continue immediately).
  const tick = async () => {
    await history?.schedulerHeartbeat(coordinator.currentJob?.id || null);
    const snap = await queueSnapshot();
    await Promise.all(snap.entries.filter((entry) => entry.state === 'quota_wait' && entry.runnableShardId)
      .map((entry) => history?.repairQuotaWait?.({
        countryCode: entry.countryCode,
        sourceId: entry.runnableShardId
      })));
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
    const shardId = pick.runnableShardId;
    if (!shardId) return rescanMs;
    const result = await coordinator.trigger('queue', { shards: [shardId] });
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
      goalDeficitBefore: goalDeficit(pick.rules),
      goalDeficitAfter: goalDeficit(after?.rules),
      fingerprintBefore: pick.sourceFingerprints[shardId],
      fingerprintAfter: after?.sourceFingerprints?.[shardId] ?? pick.sourceFingerprints[shardId],
      failureFingerprintAfter: after?.failureFingerprints?.[shardId] ?? pick.failureFingerprints[shardId],
      deterministicFailure: deterministicFailureCodes.has(String(job?.errorCode || '')),
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
      probeIntervalMs: Math.max(60_000, Number(pick.intervalDays || 1) * 24 * 60 * 60_000)
    });
    await store.apply(pick.countryCode, evaluation, completedAt, shardId);
    if (evaluation.action === 'waiting_quota') {
      await history?.pauseForQuota({
        runId: result.job.id,
        countryCode: pick.countryCode,
        sourceId: shardId
      });
    }
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
