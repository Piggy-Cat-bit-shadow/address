import { readFileSync } from 'node:fs';
import type { Database } from '../database/database.mjs';
import { evaluateCountryGoals } from '../sync/country-goals.mjs';

export type AddressDataStatus =
  | 'disabled'
  | 'ready'
  | 'below_target'
  | 'running'
  | 'cooldown_wait'
  | 'quota_wait'
  | 'source_limited'
  | 'failed'
  | 'blocked';

export interface ChinaAddressDataStatus {
  syncState?: string;
  nextAttemptAt?: string | null;
  waitReason?: string | null;
}

export interface AddressDataQueueState {
  state: string;
  reason?: string | null;
  nextAttemptAt?: string | null;
}

export interface AddressDataSource {
  id: string;
  name: string;
  homepageUrl: string;
  activeDatasetCount: number;
  acceptedCount: number;
  activeCount: number;
  latestVersion: string | null;
  latestImportedAt: string | null;
}

export interface LowestAdministrativeCoverage {
  level: number;
  covered: number;
  qualified: number;
  total: number;
  updatedAt: string | null;
}

export type AddressTargetState = 'met' | 'below_target' | 'source_limited';

export interface AddressDataCountry {
  countryCode: string;
  enabled: boolean;
  currentCount: number;
  targetCount: number;
  deficit: number;
  levelLimits: number[];
  minPerNode: number;
  coverageRatio: number;
  level1Min: number;
  level2Min: number;
  coverageLowestRatio: number | null;
  coverageLevel1Ratio: number | null;
  coverageLevel2Ratio: number | null;
  coverageActual: number;
  countMet: boolean;
  coverageMet: boolean;
  targetState: AddressTargetState;
  pruneCandidates: number;
  lowestCoverage: LowestAdministrativeCoverage | null;
  sources: AddressDataSource[];
  status: AddressDataStatus;
  nextAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  lastError: string | null;
}

interface CountryRow {
  country_code: string;
  enabled: number;
  target_count: number;
  level1_limit: number;
  level2_limit: number;
  level3_limit: number;
  level4_limit: number;
  min_per_node: number;
  coverage_ratio: number;
  level1_min: number;
  level2_min: number;
  residential_count: number | null;
  country_status: string | null;
  country_next_sync_at: string | null;
  country_last_success_at: string | null;
  country_last_error: string | null;
}

interface ShardRow {
  country_code: string;
  status: string;
  next_sync_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

interface PruneRow {
  country_code: string;
  prune_candidates: number;
}

interface SourceRow {
  country_code: string;
  source_id: string;
  source_name: string;
  homepage_url: string;
  dataset_status: string;
  accepted_count: number;
  active_count: number;
  version: string;
  imported_at: string;
}

interface SourceDefinition {
  id?: string;
  name?: string;
  homepageUrl?: string;
  countryCode?: string;
  countries?: string[];
  extracts?: Array<{ countryCode?: string }>;
}

const sourceDefinitions = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../sync/source-shards.json', import.meta.url), 'utf8')) as { sources?: SourceDefinition[] };
    return parsed.sources || [];
  } catch {
    return [];
  }
})();

const plannedSources = (): Map<string, AddressDataSource[]> => {
  const countries = new Map<string, Map<string, AddressDataSource>>();
  const add = (countryCode: string, definition: Pick<SourceDefinition, 'id' | 'name' | 'homepageUrl'>) => {
    if (!/^[A-Z]{2}$/u.test(countryCode) || !definition.id || !definition.name) return;
    const sources = countries.get(countryCode) || new Map<string, AddressDataSource>();
    sources.set(definition.id, {
      id: definition.id, name: definition.name, homepageUrl: definition.homepageUrl || '',
      activeDatasetCount: 0, acceptedCount: 0, activeCount: 0, latestVersion: null, latestImportedAt: null
    });
    countries.set(countryCode, sources);
  };
  for (const source of sourceDefinitions) {
    const countryCodes = new Set([
      source.countryCode,
      ...(source.countries || []),
      ...(source.extracts || []).map((extract) => extract.countryCode)
    ].filter((value): value is string => Boolean(value)).map((value) => value.toUpperCase()));
    for (const countryCode of countryCodes) add(countryCode, source);
  }
  for (const source of [
    { id: 'amap', name: 'AMap Web Service API', homepageUrl: 'https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch' },
    { id: 'baidu', name: 'Baidu Web Service API', homepageUrl: 'https://lbsyun.baidu.com/index.php?title=webapi/guide/webservice-placeapi' },
    { id: 'tencent', name: 'Tencent Maps Web Service API', homepageUrl: 'https://lbs.qq.com/service/webService/webServiceGuide/search/webServiceSearch' }
  ]) add('CN', source);
  return new Map([...countries].map(([countryCode, sources]) => [countryCode, [...sources.values()]]));
};

const firstIso = (values: Array<string | null | undefined>): string | null => {
  const timestamps = values.filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))));
  return timestamps.sort((left, right) => Date.parse(left) - Date.parse(right))[0] || null;
};

const latestIso = (values: Array<string | null | undefined>): string | null => {
  const timestamps = values.filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))));
  return timestamps.sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
};

const chinaState = (value: string | undefined, complete: boolean): AddressDataStatus => {
  if (complete) return 'ready';
  if (value === 'source_limited') return 'source_limited';
  if (value === 'ready') return 'below_target';
  if (['below_target', 'cooldown_wait', 'quota_wait', 'blocked'].includes(value || '')) {
    return value as AddressDataStatus;
  }
  return value === 'running' ? 'running' : 'below_target';
};

const countryState = (
  row: CountryRow,
  shards: ShardRow[],
  complete: boolean,
  china?: ChinaAddressDataStatus,
  queueState?: string
): AddressDataStatus => {
  if (!Boolean(row.enabled)) return 'disabled';
  if (row.country_code === 'CN') return chinaState(china?.syncState, complete);
  if (complete) return 'ready';
  if (['source_limited', 'no_source', 'suspended'].includes(queueState || '')) return 'source_limited';
  if (queueState === 'running') return 'running';
  if (queueState === 'quota_wait') return 'quota_wait';
  if (queueState === 'cooldown_wait') return 'cooldown_wait';
  if (queueState === 'blocked') return 'blocked';
  if (row.country_status === 'failed' || shards.some((shard) => shard.status === 'failed')) return 'failed';
  if (row.country_status === 'running' || shards.some((shard) => shard.status === 'running')) return 'running';
  return 'below_target';
};

const groupSources = (rows: SourceRow[]): Map<string, AddressDataSource[]> => {
  const countries = new Map<string, Map<string, AddressDataSource>>([...plannedSources()].map(([countryCode, sources]) => [
    countryCode, new Map(sources.map((source) => [source.id, source]))
  ]));
  for (const row of rows) {
    const sources = countries.get(row.country_code) || new Map<string, AddressDataSource>();
    const current = sources.get(row.source_id) || {
      id: row.source_id,
      name: row.source_name,
      homepageUrl: row.homepage_url,
      activeDatasetCount: 0,
      acceptedCount: 0,
      activeCount: 0,
      latestVersion: null,
      latestImportedAt: null
    };
    current.name = row.source_name;
    current.homepageUrl = row.homepage_url;
    if (row.dataset_status === 'active') current.activeDatasetCount += 1;
    current.acceptedCount += Number(row.accepted_count || 0);
    current.activeCount += row.dataset_status === 'active' ? Number(row.active_count || 0) : 0;
    if (!current.latestImportedAt || Date.parse(row.imported_at) > Date.parse(current.latestImportedAt)) {
      current.latestVersion = row.version;
      current.latestImportedAt = row.imported_at;
    }
    sources.set(row.source_id, current);
    countries.set(row.country_code, sources);
  }
  return new Map([...countries].map(([countryCode, sources]) => [
    countryCode,
    [...sources.values()].sort((left, right) => left.name.localeCompare(right.name))
  ]));
};

export const listAddressData = async (
  database: Database,
  china?: ChinaAddressDataStatus,
  queueStates: Map<string, string | AddressDataQueueState> = new Map()
): Promise<AddressDataCountry[]> => {
  const [countryResult, shardResult, pruneResult, sourceResult, goals] = await Promise.all([
    database.prepare(`SELECT policy.country_code,policy.enabled,policy.target_count,
        policy.level1_limit,policy.level2_limit,policy.level3_limit,policy.level4_limit,
        policy.min_per_node,policy.coverage_ratio,policy.level1_min,policy.level2_min,
        coverage.residential_count,country.status AS country_status,
        country.next_sync_at AS country_next_sync_at,country.last_success_at AS country_last_success_at,
        country.last_error AS country_last_error
      FROM sync_country_policies policy
      LEFT JOIN admin_coverage_stats coverage
        ON coverage.node_key=policy.country_code AND coverage.level=0
      LEFT JOIN sync_country_state country ON country.country_code=policy.country_code
      ORDER BY policy.country_code`).all<CountryRow>(),
    database.prepare(`SELECT country_code,status,next_sync_at,last_success_at,last_error
      FROM sync_shard_state ORDER BY country_code,shard_id`).all<ShardRow>(),
    database.prepare(`SELECT override.country_code,SUM(GREATEST(coverage.total_count-override.min_count,0)) AS prune_candidates
      FROM sync_node_overrides override
      JOIN admin_coverage_stats coverage ON coverage.node_key=override.node_key
      WHERE override.min_count IS NOT NULL
      GROUP BY override.country_code`).all<PruneRow>(),
    database.prepare(`SELECT dataset.country_code,source.id AS source_id,source.name AS source_name,
        source.homepage_url,dataset.status AS dataset_status,dataset.accepted_count,dataset.active_count,
        dataset.version,dataset.imported_at
      FROM address_datasets dataset
      JOIN address_sources source ON source.id=dataset.source_id
      ORDER BY dataset.country_code,source.name,dataset.imported_at DESC`).all<SourceRow>(),
    evaluateCountryGoals(database)
  ]);
  const shardsByCountry = new Map<string, ShardRow[]>();
  for (const shard of shardResult.results) {
    const shards = shardsByCountry.get(shard.country_code) || [];
    shards.push(shard);
    shardsByCountry.set(shard.country_code, shards);
  }
  const pruneByCountry = new Map(pruneResult.results.map((row) => [row.country_code, Number(row.prune_candidates || 0)]));
  const sourcesByCountry = groupSources(sourceResult.results);
  return countryResult.results.map((row) => {
    const goal = goals.get(row.country_code);
    const currentCount = goal?.current ?? Number(row.residential_count || 0);
    const targetCount = goal?.target ?? Number(row.target_count);
    const shards = shardsByCountry.get(row.country_code) || [];
    const minPerNode = Number(row.min_per_node ?? 5);
    const coverageRatio = Number(row.coverage_ratio ?? 1);
    const coverageLowestRatio = goal?.lowest?.floorRatio ?? null;
    const coverageLevel1Ratio = Number(row.level1_min || 0) > 0 ? goal?.level1?.floorRatio ?? null : null;
    const coverageLevel2Ratio = Number(row.level2_min || 0) > 0 ? goal?.level2?.floorRatio ?? null : null;
    const coverageActual = goal?.coverageActual ?? 1;
    const countMet = goal?.countMet ?? currentCount >= targetCount;
    const coverageMet = Boolean(goal?.coverageMet && goal.overrideMet);
    const complete = Boolean(goal?.complete);
    const queueValue = queueStates.get(row.country_code);
    const queue = typeof queueValue === 'string' ? { state: queueValue } : queueValue;
    const status = countryState(row, shards, complete, china, queue?.state);
    const chinaReason = status === 'blocked' && ['unconfigured', 'missing_credentials'].includes(String(china?.waitReason || ''))
      ? 'missing_api_key:china_maps' : china?.waitReason;
    const nextAttemptAt = row.country_code === 'CN'
      ? china?.nextAttemptAt || null
      : queue?.nextAttemptAt || firstIso([row.country_next_sync_at, ...shards.map((shard) => shard.next_sync_at)]);
    return {
      countryCode: row.country_code,
      enabled: Boolean(row.enabled),
      currentCount,
      targetCount,
      deficit: Math.max(0, targetCount - currentCount),
      levelLimits: [row.level1_limit, row.level2_limit, row.level3_limit, row.level4_limit].map(Number),
      minPerNode,
      coverageRatio,
      level1Min: Number(row.level1_min ?? 0),
      level2Min: Number(row.level2_min ?? 0),
      coverageLowestRatio,
      coverageLevel1Ratio,
      coverageLevel2Ratio,
      coverageActual,
      countMet,
      coverageMet,
      targetState: complete ? 'met' : status === 'source_limited' ? 'source_limited' : 'below_target',
      pruneCandidates: pruneByCountry.get(row.country_code) || 0,
      lowestCoverage: goal?.lowest ? {
        level: goal.lowest.level,
        covered: goal.lowest.covered,
        qualified: goal.lowest.qualified,
        total: goal.lowest.total,
        updatedAt: null
      } : null,
      sources: sourcesByCountry.get(row.country_code) || [],
      status,
      nextAttemptAt,
      lastSuccessfulAt: latestIso([row.country_last_success_at, ...shards.map((shard) => shard.last_success_at)]),
      lastError: row.country_code === 'CN'
        ? chinaReason || row.country_last_error || null
        : status === 'blocked' && queue?.reason ? queue.reason
          : shards.find((shard) => shard.status === 'failed')?.last_error || row.country_last_error || null
    };
  });
};
