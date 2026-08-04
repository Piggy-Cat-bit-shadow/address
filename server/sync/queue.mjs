import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadSourceCatalog, sourceAdapterRevisions } from './source-adapters.mjs';
import { evaluateCountryGoals } from './country-goals.mjs';
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
  return (right.deficit - left.deficit) || left.countryCode.localeCompare(right.countryCode);
});

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
  const timeoutFailure = ['SYNC_JOB_TIMEOUT', 'SYNC_PROCESS_TIMEOUT', 'SYNC_PROCESS_ABORTED'].includes(String(failureCode || ''));
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
    else for (const countryCode of countryCodes) delete state.countries[String(countryCode).toUpperCase()];
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
    const deficits = { belowTarget: new Set(), belowFloor: new Set() };
    for (const goal of goals.values()) {
      if (goal.countryCode === 'CN' || !goal.enabled) continue;
      if (!goal.countMet) deficits.belowTarget.add(goal.countryCode);
      if (!goal.coverageMet || !goal.overrideMet) deficits.belowFloor.add(goal.countryCode);
    }
    return { policies, counts, rules, shards, nodeTargetsUpdatedAt, catalogVersion, deficits };
  });

  // Availability mirrors ControlStore.acquireCredential filters conservatively:
  // a credential counts as available when enabled, not disabled/needs_review,
  // and any cooldown has expired. When no credential row exists (for example a
  // worker key supplied purely via environment) the quota is treated as
  // available so the country is never starved by missing bookkeeping.
  const quotaStatus = (provider, now = new Date()) => withDatabase(controlDatabase, {
    provider, known: false, available: true, nextResetAt: null, revision: ''
  }, async (database) => {
    const rows = (await database.prepare(`SELECT id,status,cooldown_until,quota_period,quota_timezone_offset,
        provider_reported_reset_at,updated_at
      FROM provider_credentials WHERE provider=? AND enabled=1 AND status<>'disabled'`).bind(provider).all()).results;
    if (!rows.length) return {
      provider,
      known: false,
      available: provider !== 'mappls',
      nextResetAt: null,
      revision: ''
    };
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
    return {
      provider,
      known: true,
      available,
      nextResetAt: nextResetAt ? new Date(nextResetAt).toISOString() : null,
      revision: sha256(JSON.stringify(rows.map((row) => [row.id, row.status, row.updated_at]).sort()))
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
    const failedShards = selectedSource?.stored.status === 'failed' ? [selectedSource.stored] : [];
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
      deterministicFailure: failedShards.length > 0
        && failedShards.every((shard) => deterministicFailureCodes.has(shard.failureCode)),
      intervalDays: Number(selectedSource?.shard.intervalDays || 1),
      consecutiveFailures: selectedSource?.matches ? Number(selectedSource.saved.consecutiveFailures || 0) : 0,
      failureCode: selectedSource?.matches ? selectedSource.saved.failureCode || null : null,
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
    } else if (legacyPauseActive) {
      entry.state = 'source_limited';
      entry.reason = persisted.reason || (persistedState === 'checked' ? CHECKED_REASON : LATCH_REASON);
      entry.latchedAt = persisted.latchedAt || null;
      entry.nextAttemptAt = persistedNextAttempt ? new Date(persistedNextAttempt).toISOString() : null;
    } else if (!configuredShards.length || !shardCountries.has(countryCode)) {
      entry.state = 'source_limited';
      entry.reason = 'no_source_shard';
    } else if (!selectedSource) {
      entry.state = 'source_limited';
      const suspended = sourceEntries.find((source) => source.savedState === 'suspended');
      const checked = sourceEntries.find((source) => source.savedState === 'checked');
      entry.reason = suspended?.saved.reason || checked?.saved.reason || LATCH_REASON;
      entry.nextAttemptAt = pausedWakeAt ? new Date(pausedWakeAt).toISOString() : null;
    } else if (provider && quota && !quota.available) {
      entry.state = 'waiting_quota';
      entry.nextAttemptAt = quota.nextResetAt;
      entry.reason = provider;
    } else {
      entry.state = 'queued';
      if (delayedUntil) {
        entry.nextAttemptAt = new Date(delayedUntil).toISOString();
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

// Continuous queue engine. It keeps one runnable source shard in flight while
// preserving independent exhausted and retry states for every source.
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
        if (!entry || ['done', 'source_limited'].includes(entry.state)) continue;
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
    const snap = await queueSnapshot();
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
    const result = await coordinator.trigger('scheduled', { shards: [shardId] });
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
      probeIntervalMs: Math.max(60_000, Number(pick.intervalDays || 1) * 24 * 60 * 60_000)
    });
    await store.apply(pick.countryCode, evaluation, completedAt, shardId);
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
