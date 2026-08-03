import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Database } from '../database/database.mjs';
import { findNonResidentialMatch } from '../../src/domain/non-residential.mjs';
import { matchesCustomBlacklist } from '../lib/custom-blacklist.mjs';
import type { ControlStore, ProviderName, ProviderQuotaObservation } from '../control/store';
import { refreshAddressCoverage } from '../control/coverage';
import {
  chinaCommunityPublicationClause,
  chinaFreshTimestampClause
} from '../api/repositories/china-community';
import { distanceMeters } from './coordinates';
import { providerFetcher, ProviderRequestError, type CommunityCandidate, type ProviderPage } from './providers';
import { isChinaDeliveryAddress, normalizeChinaProviderAddress } from './quality';
import { getCountryPolicy, type CountryPolicy } from '../sync/address-policy.mjs';

export const initialChinaCities = [
  '北京市', '天津市', '上海市', '重庆市', '石家庄市', '太原市', '呼和浩特市', '沈阳市', '长春市', '哈尔滨市',
  '南京市', '杭州市', '合肥市', '福州市', '南昌市', '济南市', '郑州市', '武汉市', '长沙市', '广州市',
  '南宁市', '海口市', '成都市', '贵阳市', '昆明市', '拉萨市', '西安市', '兰州市', '西宁市', '银川市',
  '乌鲁木齐市', '深圳市', '厦门市', '青岛市', '大连市', '宁波市', '苏州市', '唐山市', '无锡市', '佛山市',
  '东莞市', '珠海市', '泉州市'
];

const normalizedName = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('zh-CN')
  .replace(/[·•・\s()（）【】\[\]_-]/gu, '').replace(/(?:小区|社区|花园|公寓|家园|住宅区)$/u, '');
const normalizedAddress = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('zh-CN')
  .replace(/[\s,，。．·•・()（）【】\[\]_-]/gu, '');
const comparableAdmin = (value: string): string => value.normalize('NFKC').replace(/[省市区县]$/u, '');
const addressRoads = (value: string): string[] => [...value.matchAll(/([\p{L}\p{N}]{2,}?(?:大道|大街|公路|路|街|巷|道|弄))/gu)]
  .map((match) => match[1]);
const premiseNumbers = (value: string): string[] => [...value.normalize('NFKC')
  .matchAll(/(?:大道|大街|公路|路|街|巷|道|弄)([0-9]+(?:(?:弄|巷)[0-9]+)?(?:[-之][0-9]+)?(?:号|號)(?:院)?)/gu)]
  .map((match) => match[1].replace(/號/gu, '号').replace(/院$/u, ''));
const roadsAgree = (left: string[], right: string[]): boolean => left.some((leftRoad) => right.some((rightRoad) =>
  leftRoad === rightRoad || (Math.min(leftRoad.length, rightRoad.length) >= 3
    && (leftRoad.endsWith(rightRoad) || rightRoad.endsWith(leftRoad)))));
const addressesAgree = (left: string, right: string): boolean => {
  const normalizedLeft = normalizedAddress(left);
  const normalizedRight = normalizedAddress(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const leftPremises = premiseNumbers(left);
  const rightPremises = premiseNumbers(right);
  if (leftPremises.length || rightPremises.length) {
    if (!leftPremises.length || !rightPremises.length) return false;
    const rightPremiseSet = new Set(rightPremises);
    if (!leftPremises.some((premise) => rightPremiseSet.has(premise))) return false;
  }
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;
  return roadsAgree(addressRoads(normalizedLeft), addressRoads(normalizedRight));
};
const providerResidentialTypeValid = (candidate: CommunityCandidate): boolean => candidate.provider === 'amap'
  ? candidate.typecode === '120302'
  : /(?:住宅|小区|公寓|家园|花园|新村|嘉园|名苑|家属院)/u.test(candidate.typecode);
const nowIso = (): string => new Date().toISOString();
const providerQuotaTimezoneOffsetMinutes = 480;
// China map providers reset their daily request quotas at UTC+8 midnight.
export const nextProviderQuotaBoundary = (now = new Date()): Date => {
  const offsetMs = providerQuotaTimezoneOffsetMinutes * 60_000;
  const shifted = new Date(now.getTime() + offsetMs);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  return new Date(shifted.getTime() - offsetMs);
};
const coverageProviderPriority: ProviderName[] = ['amap', 'tencent', 'baidu'];
const maxPagesPerTarget = 8;
const candidateYieldInterval = 25;
const targetYieldInterval = 50;
const maxAreaCityBytes = 128 * 1024 * 1024;
const checkpointStrategyVersion = 'community-poi-v7';
const credentialPacingMaxWaitMs = 1_100;
const mainlandProvincePrefixes = [
  '11', '12', '13', '14', '15', '21', '22', '23', '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46', '50', '51', '52', '53', '54', '61', '62', '63', '64', '65'
];
const mainlandProvinceSql = mainlandProvincePrefixes.map((prefix) => `'${prefix}'`).join(',');
// AreaCity splits direct municipalities into pseudo-cities (重庆城区/重庆郊县) while providers
// return the municipality name itself; match on the target province in that case.
const communityAreaMatch = (community = 'community', target = 'target'): string =>
  `${community}.district=${target}.district AND (${community}.city=${target}.city
    OR (${community}.city=${target}.province AND ${community}.province=${target}.province))`;

interface AreaNode {
  id?: string | number;
  code?: string | number;
  ext_id?: string | number;
  pid?: string | number;
  parent_id?: string | number;
  name?: string;
  level?: string | number;
  longitude?: number | string;
  latitude?: number | string;
  geo?: string;
  children?: AreaNode[];
  child?: AreaNode[];
}

interface AreaRow {
  adcode: string;
  parent: string | null;
  level: string;
  name: string;
  path: string;
  longitude: number | null;
  latitude: number | null;
}

export interface ChinaAreaListQuery {
  provinceAdcode?: string;
  cityAdcode?: string;
  districtAdcode?: string;
  page?: number;
  pageSize?: number;
}

export interface ChinaAreaOption { adcode: string; name: string }
export interface ChinaAreaListResult {
  items: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
  options: { provinces: ChinaAreaOption[]; cities: ChinaAreaOption[]; districts: ChinaAreaOption[] };
}

export interface SyncTarget {
  id: string;
  province: string;
  city: string;
  district: string;
  query: string;
  targetCount: number;
}

export interface ChinaWorkerConfig {
  postgresUrl: string;
  masterKey: Buffer;
}

export interface ChinaWorkerData {
  postgresUrl: string;
  masterKey: Uint8Array;
  dataRoot: string;
  runId: string;
  targets: SyncTarget[];
  providers: ProviderName[];
}

export type ChinaWorkerMessage =
  | { type: 'progress'; progress: Record<string, unknown> }
  | { type: 'done'; syncState: string; waitReason: string };

interface ChinaAreaRow {
  adcode: string;
  province: string;
  city: string;
  district: string;
  count: number;
}

const utf8Hex = (value: string): string => Buffer.from(value, 'utf8').toString('hex').toUpperCase();

const candidateFromIngestRow = (row: Record<string, unknown>): CommunityCandidate => ({
  provider: String(row.provider) as ProviderName,
  providerPoiId: String(row.provider_poi_id),
  name: String(row.name),
  address: String(row.address),
  province: String(row.province),
  city: String(row.city),
  district: String(row.district),
  township: String(row.township),
  longitude: Number(row.longitude),
  latitude: Number(row.latitude),
  rawLongitude: Number(row.raw_longitude),
  rawLatitude: Number(row.raw_latitude),
  rawCrs: String(row.raw_crs) as CommunityCandidate['rawCrs'],
  responseHash: String(row.response_hash),
  typecode: String(row.typecode),
  adcode: String(row.adcode)
});

export const chinaNodeScope = (nodeKey: string): Record<string, string> | null => {
  const parts = nodeKey.split(':');
  const decode = (hexValue: string): string => Buffer.from(hexValue, 'hex').toString('utf8');
  if (parts[0] !== 'CN') return null;
  if (parts[1] === 'a1' && parts.length === 3) return { province: decode(parts[2]) };
  if (parts[1] === 'loc' && parts.length === 4) return { province: decode(parts[2]), city: decode(parts[3]) };
  if (parts[1] === 'dist' && parts.length === 5) {
    return { province: decode(parts[2]), city: decode(parts[3]), district: decode(parts[4]) };
  }
  return null;
};

interface CoverageNodeState { count: number; target: number }

export class ChinaCoverageTracker {
  private readonly districts = new Map<string, CoverageNodeState & { province: string; cityKey: string }>();
  private readonly cities = new Map<string, CoverageNodeState>();
  private readonly provinces = new Map<string, CoverageNodeState>();
  private readonly coverageRatio: number;
  private satisfiedDistricts = 0;
  private satisfiedCities = 0;
  private satisfiedProvinces = 0;
  private constrainedDistricts = 0;
  private constrainedCities = 0;
  private constrainedProvinces = 0;

  constructor(
    rows: ChinaAreaRow[],
    policy: { minPerNode: number; coverageRatio: number; level1Min: number; level2Min: number },
    overrides: Map<string, number>
  ) {
    this.coverageRatio = policy.coverageRatio;
    for (const row of rows) {
      const cityKey = `${row.province}|${row.city}`;
      if (!this.provinces.has(row.province)) {
        this.provinces.set(row.province, { count: 0, target: overrides.get(`CN:a1:${utf8Hex(row.province)}`) ?? policy.level1Min });
      }
      if (!this.cities.has(cityKey)) {
        this.cities.set(cityKey, {
          count: 0, target: overrides.get(`CN:loc:${utf8Hex(row.province)}:${utf8Hex(row.city)}`) ?? policy.level2Min
        });
      }
      this.provinces.get(row.province)!.count += row.count;
      this.cities.get(cityKey)!.count += row.count;
      this.districts.set(row.adcode, {
        province: row.province, cityKey, count: row.count,
        target: overrides.get(`CN:dist:${utf8Hex(row.province)}:${utf8Hex(row.city)}:${utf8Hex(row.district)}`) ?? policy.minPerNode
      });
    }
    const satisfied = (node: CoverageNodeState): boolean => node.target <= 0 || node.count >= node.target;
    for (const node of this.districts.values()) {
      if (node.target > 0) this.constrainedDistricts += 1;
      if (satisfied(node)) this.satisfiedDistricts += 1;
    }
    for (const node of this.cities.values()) {
      if (node.target > 0) this.constrainedCities += 1;
      if (satisfied(node)) this.satisfiedCities += 1;
    }
    for (const node of this.provinces.values()) {
      if (node.target > 0) this.constrainedProvinces += 1;
      if (satisfied(node)) this.satisfiedProvinces += 1;
    }
  }

  get size(): number { return this.districts.size; }

  record(adcode: string, inserted: number): void {
    const district = this.districts.get(adcode);
    if (!district || !inserted) return;
    const bump = (node: CoverageNodeState, onSatisfied: () => void): void => {
      if (node.target > 0 && node.count < node.target && node.count + inserted >= node.target) onSatisfied();
      node.count += inserted;
    };
    bump(district, () => { this.satisfiedDistricts += 1; });
    bump(this.cities.get(district.cityKey)!, () => { this.satisfiedCities += 1; });
    bump(this.provinces.get(district.province)!, () => { this.satisfiedProvinces += 1; });
  }

  needsSync(adcode: string): boolean {
    const district = this.districts.get(adcode);
    if (!district) return true;
    if (district.target > 0 && district.count < district.target) return true;
    const city = this.cities.get(district.cityKey)!;
    if (city.target > 0 && city.count < city.target) return true;
    const province = this.provinces.get(district.province)!;
    return province.target > 0 && province.count < province.target;
  }

  deficit(adcode: string): number {
    const district = this.districts.get(adcode);
    if (!district) return 0;
    const city = this.cities.get(district.cityKey)!;
    const province = this.provinces.get(district.province)!;
    return Math.max(0, district.target - district.count)
      + Math.max(0, city.target - city.count)
      + Math.max(0, province.target - province.count);
  }

  ratio(): number {
    const parts: number[] = [];
    if (this.constrainedDistricts && this.districts.size) parts.push(this.satisfiedDistricts / this.districts.size);
    if (this.constrainedCities && this.cities.size) parts.push(this.satisfiedCities / this.cities.size);
    if (this.constrainedProvinces && this.provinces.size) parts.push(this.satisfiedProvinces / this.provinces.size);
    return parts.length ? Math.min(...parts) : 1;
  }

  met(): boolean {
    return !this.districts.size || this.ratio() >= this.coverageRatio;
  }

  uncovered(): string[] {
    return [...this.districts.keys()].filter((adcode) => this.needsSync(adcode));
  }
}

const csvRecords = (text: string): string[][] => {
  const records: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(value); value = ''; }
    else if (character === '\n') { row.push(value.replace(/\r$/u, '')); records.push(row); row = []; value = ''; }
    else value += character;
  }
  if (value || row.length) { row.push(value.replace(/\r$/u, '')); records.push(row); }
  return records;
};

export class ChinaDataService {
  private running = false;
  private continuationTimer: NodeJS.Timeout | undefined;
  private activeWorker: Worker | undefined;
  private lastProgress: Record<string, unknown> | null = null;
  private closed = false;
  private syncState: 'ready' | 'below_target' | 'cooldown_wait' | 'quota_wait' | 'source_limited' | 'blocked' = 'below_target';
  private nextAttemptAt: string | null = null;
  private waitReason = '';
  private statusSnapshot: { expiresAt: number; promise: Promise<Record<string, unknown>> } | undefined;

  constructor(
    private readonly addressDb: Database,
    private readonly control: ControlStore,
    private readonly dataRoot = resolve('data'),
    private readonly workerConfig?: ChinaWorkerConfig
  ) {}

  private async persistRuntimeState(goalState: 'complete' | 'incomplete' | 'disabled'): Promise<void> {
    await this.addressDb.prepare(`INSERT INTO sync_country_runtime(
        country_code,goal_state,execution_state,next_attempt_at,reason,updated_at
      ) VALUES ('CN',?,?,?,?,?)
      ON CONFLICT(country_code) DO UPDATE SET goal_state=excluded.goal_state,
        execution_state=excluded.execution_state,next_attempt_at=excluded.next_attempt_at,
        reason=excluded.reason,updated_at=excluded.updated_at`)
      .bind(goalState, this.running ? 'running' : this.syncState, this.nextAttemptAt, this.waitReason || null, nowIso()).run();
  }

  private markSchedulingFailure(reason = 'SYNC_SCHEDULER_FAILED'): void {
    this.syncState = 'blocked';
    this.nextAttemptAt = null;
    this.waitReason = reason;
    void this.persistRuntimeState('incomplete').catch(() => undefined);
  }

  async initializeTargets(options: { scheduleContinuation?: boolean } = {}): Promise<void> {
    const now = nowIso();
    await this.addressDb.batch(initialChinaCities.map((city, index) => this.addressDb.prepare(`INSERT INTO cn_sync_targets(
      city,province,priority,enabled,target_count,updated_at) VALUES (?,?,?,1,?,?)
      ON CONFLICT (city) DO NOTHING`).bind(city, '', index + 1, index < 31 ? 800 : 500, now)));
    await this.refreshAreaTargets();
    await this.rebuildPublishedCommunitiesFromCandidates();
    if (!this.workerConfig) await this.reprocessRejectedMismatches();
    await this.reconcileCommunityVerification();
    if (options.scheduleContinuation !== false) {
      void this.scheduleContinuation(1_000).catch(() => this.markSchedulingFailure());
    }
  }

  private async rebuildPublishedCommunitiesFromCandidates(): Promise<void> {
    const publishedRows = Number(await this.addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2').first('total') || 0);
    if (publishedRows) return;
    const acceptedRows = Number(await this.addressDb.prepare("SELECT COUNT(*) AS total FROM cn_ingest_candidates WHERE decision='accepted'")
      .first('total') || 0);
    if (!acceptedRows) return;
    const baselineTarget = (await getCountryPolicy(this.addressDb, 'CN')).minPerNode;
    let provider = '';
    let providerPoiId = '';
    for (;;) {
      const rows = (await this.addressDb.prepare(`SELECT provider,provider_poi_id,target_adcode,name,address,province,city,district,
        township,longitude,latitude,raw_longitude,raw_latitude,raw_crs,response_hash,typecode,adcode
        FROM cn_ingest_candidates WHERE decision='accepted'
          AND (provider>? OR (provider=? AND provider_poi_id>?))
        ORDER BY provider,provider_poi_id LIMIT 500`).bind(provider, provider, providerPoiId)
        .all<Record<string, unknown>>()).results;
      if (!rows.length) break;
      for (const row of rows) {
        const candidate = candidateFromIngestRow(row);
        await this.processCandidate(candidate, {
          id: String(row.target_adcode), province: candidate.province, city: candidate.city,
          district: candidate.district, query: `${candidate.city}${candidate.district}`, targetCount: baselineTarget
        });
      }
      const last = rows.at(-1)!;
      provider = String(last.provider);
      providerPoiId = String(last.provider_poi_id);
    }
  }

  private async reprocessRejectedMismatches(): Promise<void> {
    // Candidates rejected only for the municipality pseudo-city mismatch are recoverable
    // without spending any provider quota; replay them through the acceptance pipeline.
    let provider = '';
    let providerPoiId = '';
    for (;;) {
      const rows = (await this.addressDb.prepare(`SELECT provider,provider_poi_id,target_adcode,name,address,province,city,district,
        township,longitude,latitude,raw_longitude,raw_latitude,raw_crs,response_hash,typecode,adcode
        FROM cn_ingest_candidates WHERE decision='rejected' AND rejection_reason='administrative_mismatch'
          AND (provider>? OR (provider=? AND provider_poi_id>?))
        ORDER BY provider,provider_poi_id LIMIT 500`).bind(provider, provider, providerPoiId)
        .all<Record<string, unknown>>()).results;
      if (!rows.length) break;
      for (const row of rows) {
        const candidate = candidateFromIngestRow(row);
        await this.processCandidate(candidate, {
          id: String(row.target_adcode), province: candidate.province, city: candidate.city,
          district: candidate.district, query: `${candidate.city}${candidate.district}`, targetCount: 0
        });
      }
      const last = rows.at(-1)!;
      provider = String(last.provider);
      providerPoiId = String(last.provider_poi_id);
    }
  }

  private async reconcileCommunityVerification(): Promise<void> {
    await this.addressDb.prepare(`UPDATE cn_communities_v2 SET
      source_count=GREATEST(1,source_counts.fresh_count),
      verification_level=CASE WHEN source_counts.fresh_count>=3 THEN 'L3'
        WHEN source_counts.fresh_count>=2 THEN 'L2' ELSE 'L1' END,
      updated_at=?
    FROM (
      SELECT source.community_id,
        COUNT(DISTINCT CASE WHEN ${chinaFreshTimestampClause('source.last_seen_at')} THEN source.provider END) AS fresh_count
      FROM cn_community_sources source GROUP BY source.community_id
    ) source_counts WHERE source_counts.community_id=cn_communities_v2.id
      AND (cn_communities_v2.source_count<>GREATEST(1,source_counts.fresh_count)
        OR cn_communities_v2.verification_level<>CASE WHEN source_counts.fresh_count>=3 THEN 'L3'
          WHEN source_counts.fresh_count>=2 THEN 'L2' ELSE 'L1' END)`).bind(nowIso()).run();
  }

  private async refreshAreaTargets(): Promise<void> {
    const baselineTarget = (await getCountryPolicy(this.addressDb, 'CN')).minPerNode;
    await this.addressDb.prepare(`UPDATE cn_sync_area_targets SET enabled=0,updated_at=?
      WHERE substr(adcode,1,2) NOT IN (${mainlandProvinceSql})`).bind(nowIso()).run();
    const areas = (await this.addressDb.prepare(`SELECT adcode,parent_adcode,level,name FROM cn_admin_areas
      WHERE level IN ('province','city','district')`).all<{
      adcode: string; parent_adcode: string | null; level: string; name: string;
    }>()).results;
    const byAdcode = new Map(areas.map((area) => [area.adcode, area]));
    const targets = areas.flatMap((district) => {
      if (district.level !== 'district') return [];
      const city = district.parent_adcode ? byAdcode.get(district.parent_adcode) : undefined;
      const province = city?.parent_adcode ? byAdcode.get(city.parent_adcode) : undefined;
      if (!city || !province || !mainlandProvincePrefixes.includes(province.adcode.slice(0, 2))) return [];
      return [[district.adcode, province.name, city.name, district.name, `${city.name}${district.name}`,
        baselineTarget, Number(district.adcode), 1, nowIso()]];
    });
    for (let offset = 0; offset < targets.length; offset += 500) {
      const chunk = targets.slice(offset, offset + 500);
      await this.addressDb.prepare(`INSERT INTO cn_sync_area_targets(
        adcode,province,city,district,query,target_count,priority,enabled,updated_at) VALUES
        ${chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}
        ON CONFLICT(adcode) DO UPDATE SET province=excluded.province,city=excluded.city,district=excluded.district,
          query=excluded.query,target_count=CASE WHEN cn_sync_area_targets.target_count=10 THEN excluded.target_count
            ELSE cn_sync_area_targets.target_count END,priority=excluded.priority,enabled=1,updated_at=excluded.updated_at`)
        .bind(...chunk.flat()).run();
    }
  }

  private async loadStatusSnapshot(): Promise<Record<string, unknown>> {
    const counts = await this.addressDb.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN source_count>=2 THEN 1 ELSE 0 END),0) AS cross_verified,
      COUNT(DISTINCT city) AS cities FROM cn_communities_v2 community
      WHERE ${chinaCommunityPublicationClause('community')}`).first<Record<string, unknown>>();
    let coverage = await this.addressDb.prepare(`SELECT COUNT(*) AS districts_total,
      SUM(CASE WHEN current_count>=target_count THEN 1 ELSE 0 END) AS districts_covered,
      SUM(GREATEST(target_count-current_count,0)) AS communities_needed FROM (
        SELECT target.adcode,target.target_count,COUNT(community.id) AS current_count
        FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
          ON ${communityAreaMatch()}
          AND ${chinaCommunityPublicationClause('community')}
        WHERE target.enabled=1 GROUP BY target.adcode,target.target_count
      ) coverage_counts`).first<Record<string, unknown>>();
    const usingFallback = Number(coverage?.districts_total || 0) === 0;
    if (usingFallback) {
      coverage = await this.addressDb.prepare(`SELECT COUNT(*) AS districts_total,
        SUM(CASE WHEN current_count>=5 THEN 1 ELSE 0 END) AS districts_covered,
        GREATEST(COUNT(*)*5-COALESCE(SUM(current_count),0),0) AS communities_needed FROM (
          SELECT target.city,COUNT(community.id) AS current_count FROM cn_sync_targets target
          LEFT JOIN cn_communities_v2 community ON community.city=target.city
            AND ${chinaCommunityPublicationClause('community')}
          WHERE target.enabled=1 GROUP BY target.city
        ) coverage_counts`).first<Record<string, unknown>>();
    }
    return { ...counts, coverage, usingFallback };
  }

  async status(): Promise<Record<string, unknown>> {
    if (!this.statusSnapshot || this.statusSnapshot.expiresAt <= Date.now()) {
      const promise = this.loadStatusSnapshot();
      this.statusSnapshot = { expiresAt: Number.POSITIVE_INFINITY, promise };
      void promise.then(() => {
        if (this.statusSnapshot?.promise === promise) this.statusSnapshot.expiresAt = Date.now() + 3_000;
      }, () => {
        if (this.statusSnapshot?.promise === promise) this.statusSnapshot = undefined;
      });
    }
    const aggregate = await this.statusSnapshot.promise;
    return {
      ...aggregate, running: this.running,
      syncState: this.running ? 'running' : this.syncState,
      nextAttemptAt: this.nextAttemptAt,
      waitReason: this.waitReason,
      progress: this.lastProgress
    };
  }

  async listAreas(query: ChinaAreaListQuery = {}): Promise<ChinaAreaListResult> {
    const page = Math.max(1, Math.trunc(query.page || 1));
    const pageSize = Math.max(1, Math.min(100, Math.trunc(query.pageSize || 25)));
    const filters: string[] = ['target.enabled=1'];
    const bindings: string[] = [];
    if (query.provinceAdcode) { filters.push('province.adcode=?'); bindings.push(query.provinceAdcode); }
    if (query.cityAdcode) { filters.push('city.adcode=?'); bindings.push(query.cityAdcode); }
    if (query.districtAdcode) { filters.push('district.adcode=?'); bindings.push(query.districtAdcode); }
    const where = filters.join(' AND ');
    const hierarchy = `FROM cn_sync_area_targets target
      JOIN cn_admin_areas district ON district.adcode=target.adcode AND district.level='district'
      JOIN cn_admin_areas city ON city.adcode=district.parent_adcode AND city.level='city'
      JOIN cn_admin_areas province ON province.adcode=city.parent_adcode AND province.level='province'`;
    const total = Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total ${hierarchy} WHERE ${where}`)
      .bind(...bindings).first<number>('total') || 0);
    const itemRows = (await this.addressDb.prepare(`SELECT target.province,target.city,target.adcode AS district_adcode,target.district,
      target.target_count,COUNT(community.id) AS current_count ${hierarchy}
      LEFT JOIN cn_communities_v2 community ON community.province=target.province
        AND ${communityAreaMatch()}
        AND ${chinaCommunityPublicationClause('community')}
      WHERE ${where} GROUP BY target.adcode,target.province,target.city,target.district,target.target_count,target.priority
      ORDER BY current_count,target.priority,district.adcode LIMIT ? OFFSET ?`)
      .bind(...bindings, pageSize, (page - 1) * pageSize).all<Record<string, unknown>>()).results;
    const adminRows = (await this.addressDb.prepare(`SELECT adcode,parent_adcode FROM cn_admin_areas
      WHERE level IN ('city','district')`).all<{ adcode: string; parent_adcode: string }>()).results;
    const parentByAdcode = new Map(adminRows.map((row) => [row.adcode, row.parent_adcode]));
    const items = itemRows.map((row) => {
      const districtAdcode = String(row.district_adcode);
      const cityAdcode = parentByAdcode.get(districtAdcode) || '';
      return { ...row, city_adcode: cityAdcode, province_adcode: parentByAdcode.get(cityAdcode) || '' };
    });
    const provinces = (await this.addressDb.prepare(`SELECT adcode,name FROM cn_admin_areas
      WHERE level='province' AND substr(adcode,1,2) IN (${mainlandProvinceSql}) ORDER BY adcode`)
      .all<ChinaAreaOption>()).results;
    const cities = query.provinceAdcode ? (await this.addressDb.prepare(`SELECT adcode,name FROM cn_admin_areas
      WHERE level='city' AND parent_adcode=? ORDER BY adcode`).bind(query.provinceAdcode).all<ChinaAreaOption>()).results : [];
    const districts = query.cityAdcode ? (await this.addressDb.prepare(`SELECT adcode,name FROM cn_admin_areas
      WHERE level='district' AND parent_adcode=? ORDER BY adcode`).bind(query.cityAdcode).all<ChinaAreaOption>()).results : [];
    return { items, total, page, pageSize, options: { provinces, cities, districts } };
  }

  async start(_input: { cities?: string[]; providers?: ProviderName[]; maxPages?: number } = {}): Promise<string> {
    if (this.running) throw new Error('CHINA_SYNC_BUSY');
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = undefined;
    await this.refreshAreaTargets();
    const rows = (await this.addressDb.prepare(`SELECT target.adcode AS id,target.province,target.city,target.district,target.query,
      target.target_count FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
      ON ${communityAreaMatch()}
      AND ${chinaCommunityPublicationClause('community')}
      WHERE target.enabled=1 GROUP BY target.adcode,target.province,target.city,target.district,target.query,
        target.target_count,target.priority ORDER BY COUNT(community.id),target.priority`).all<Record<string, unknown>>()).results;
    const targets: SyncTarget[] = rows.map((row) => ({
      id: String(row.id), province: String(row.province), city: String(row.city), district: String(row.district),
      query: String(row.query), targetCount: Number(row.target_count)
    }));
    if (!targets.length) {
      const baselineTarget = (await getCountryPolicy(this.addressDb, 'CN')).minPerNode;
      targets.push(...initialChinaCities.map((city) => ({
        id: city, province: '', city, district: '', query: city, targetCount: baselineTarget
      })));
    }
    const providers = await this.control.availableProviders();
    if (!providers.length) {
      await this.scheduleContinuation();
      throw new Error('NO_AVAILABLE_KEY');
    }
    const runId = await this.control.createRun('china-communities', { mode: 'automatic', targets: targets.length, providers });
    this.running = true;
    this.syncState = 'below_target';
    this.nextAttemptAt = null;
    this.waitReason = '';
    await this.persistRuntimeState('incomplete');
    if (this.workerConfig) {
      try {
        this.launchWorker(runId, targets, providers);
      } catch (error) {
        this.running = false;
        this.markSchedulingFailure('CHINA_SYNC_WORKER');
        await this.control.updateRun(runId, 'failed', {}, {
          code: 'CHINA_SYNC_WORKER', message: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined);
        throw error;
      }
    } else {
      void this.execute(runId, targets, providers).finally(() => {
        this.running = false;
        void this.scheduleContinuation().catch(() => this.markSchedulingFailure());
      });
    }
    return runId;
  }

  async runSync(runId: string, targets: SyncTarget[], providers: ProviderName[]): Promise<{ syncState: string; waitReason: string }> {
    await this.reprocessRejectedMismatches().catch(() => undefined);
    await this.execute(runId, targets, providers);
    return { syncState: this.syncState, waitReason: this.waitReason };
  }

  private launchWorker(runId: string, targets: SyncTarget[], providers: ProviderName[]): void {
    const config = this.workerConfig!;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      workerData: {
        postgresUrl: config.postgresUrl,
        masterKey: config.masterKey,
        dataRoot: this.dataRoot,
        runId, targets, providers
      } satisfies ChinaWorkerData
    });
    this.activeWorker = worker;
    let completed = false;
    let settled = false;
    worker.on('message', (message: ChinaWorkerMessage) => {
      if (message?.type === 'progress') this.lastProgress = message.progress;
      else if (message?.type === 'done') {
        completed = true;
        if (message.syncState === 'source_limited') {
          this.syncState = 'source_limited';
          this.waitReason = message.waitReason || 'validated_sources_exhausted';
        }
      }
    });
    const settle = (failure?: string): void => {
      if (settled) return;
      settled = true;
      if (this.activeWorker === worker) this.activeWorker = undefined;
      this.running = false;
      if (this.closed) return;
      const markFailed = failure
        ? this.control.updateRun(runId, 'failed', {}, { code: 'CHINA_SYNC_WORKER', message: failure }).catch(() => undefined)
        : Promise.resolve();
      void markFailed.then(() => this.scheduleContinuation()).catch(() => this.markSchedulingFailure());
    };
    worker.once('error', (error) => {
      void worker.terminate().catch(() => undefined);
      settle(error instanceof Error ? error.message : String(error));
    });
    worker.once('exit', (code) => settle(completed || code === 0 ? undefined : `CHINA_SYNC_WORKER_EXIT_${code}`));
  }

  async wake(delayMs = 0): Promise<void> {
    this.syncState = 'below_target';
    this.nextAttemptAt = null;
    this.waitReason = '';
    await this.scheduleContinuation(delayMs);
  }

  close(): void {
    this.closed = true;
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = undefined;
    const worker = this.activeWorker;
    if (!worker) return;
    worker.postMessage({ type: 'stop' });
    const grace = setTimeout(() => { void worker.terminate().catch(() => undefined); }, 5_000);
    grace.unref?.();
    worker.once('exit', () => clearTimeout(grace));
  }

  private async scheduleContinuation(minimumDelayMs = 1_000): Promise<void> {
    if (this.closed || this.running) return;
    const policy = await getCountryPolicy(this.addressDb, 'CN');
    const completion = policy.enabled ? await this.completionState(policy) : 'met';
    if (!policy.enabled || completion === 'met') {
      this.syncState = 'ready';
      this.nextAttemptAt = null;
      this.waitReason = '';
      if (this.continuationTimer) clearTimeout(this.continuationTimer);
      this.continuationTimer = undefined;
      await this.persistRuntimeState(policy.enabled ? 'complete' : 'disabled');
      return;
    }
    if (this.syncState === 'source_limited') {
      this.nextAttemptAt = null;
      if (this.continuationTimer) clearTimeout(this.continuationTimer);
      this.continuationTimer = undefined;
      await this.persistRuntimeState('incomplete');
      return;
    }
    const availability = await this.control.credentialAvailability(['amap', 'baidu', 'tencent']);
    if (!availability.configured || availability.reason === 'blocked') {
      this.syncState = 'blocked';
      this.waitReason = availability.reason;
      this.nextAttemptAt = null;
      await this.persistRuntimeState('incomplete');
      return;
    }
    const dueAt = availability.eligible
      ? new Date(Date.now() + Math.max(0, minimumDelayMs))
      : availability.nextAvailableAt ? new Date(availability.nextAvailableAt) : null;
    if (!dueAt || !Number.isFinite(dueAt.getTime())) {
      this.syncState = availability.reason === 'quota' ? 'quota_wait' : 'blocked';
      this.waitReason = availability.reason;
      this.nextAttemptAt = null;
      await this.persistRuntimeState('incomplete');
      return;
    }
    this.syncState = availability.reason === 'quota' ? 'quota_wait'
      : availability.reason === 'cooldown' ? 'cooldown_wait' : 'below_target';
    this.waitReason = availability.reason;
    this.armContinuation(dueAt);
    await this.persistRuntimeState('incomplete');
  }

  private armContinuation(dueAt: Date): void {
    this.nextAttemptAt = dueAt.toISOString();
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = undefined;
      void this.start().catch((error) => {
        if (!(error instanceof Error) || !['CHINA_SYNC_BUSY', 'NO_AVAILABLE_KEY'].includes(error.message)) {
          this.markSchedulingFailure(error instanceof Error ? error.message : 'SYNC_START_FAILED');
        }
        void this.scheduleContinuation().catch(() => this.markSchedulingFailure());
      });
    }, Math.max(250, dueAt.getTime() - Date.now()));
    this.continuationTimer.unref?.();
  }

  private async execute(runId: string, targets: SyncTarget[], providers: ProviderName[]): Promise<void> {
    let accepted = 0;
    let requests = 0;
    let adapterRejectedPages = 0;
    const unavailable = new Set<ProviderName>();
    try {
      const policy = await getCountryPolicy(this.addressDb, 'CN');
      if (!policy.enabled) {
        await this.control.updateRun(runId, 'succeeded', { phase: 'disabled', accepted, requests, targets: 0, providers: 0 });
        return;
      }
      const countryTarget = policy.targetCount;
      await this.pruneOverriddenExcess();
      // In-memory counters replace per-page COUNT queries and reduce database round trips.
      // so repeated counting over cn_communities_v2 starves the event loop.
      let publishedCount = await this.publishedCommunityCount();
      const tracker = await this.coverageTracker(policy);
      const targetCounts = new Map<string, number>();
      let processedCandidates = 0;
      let targetIterations = 0;
      const countMet = () => publishedCount >= countryTarget;
      const quotaReached = () => countMet() && tracker.met();
      const coverageSkipped = (target: SyncTarget) => countMet() && !tracker.needsSync(target.id);
      if (countMet() && !tracker.met()) {
        targets = [...targets].sort((left, right) => tracker.deficit(right.id) - tracker.deficit(left.id));
        providers = coverageProviderPriority.filter((provider) => providers.includes(provider));
      }
      const yieldEventLoop = () => new Promise((resolveYield) => setImmediate(resolveYield));
      const currentTargetCount = async (target: SyncTarget): Promise<number> => {
        const known = targetCounts.get(target.id);
        if (known !== undefined) return known;
        const initial = await this.targetCount(target);
        targetCounts.set(target.id, initial);
        return initial;
      };
      const processCandidates = async (candidates: CommunityCandidate[], target: SyncTarget): Promise<void> => {
        let current = await currentTargetCount(target);
        for (const candidate of candidates) {
          if (quotaReached()) break;
          const inserted = await this.processCandidate(candidate, target);
          accepted += inserted;
          publishedCount += inserted;
          current += inserted;
          targetCounts.set(target.id, current);
          tracker.record(target.id, inserted);
          processedCandidates += 1;
          if (processedCandidates % candidateYieldInterval === 0) await yieldEventLoop();
        }
      };
      const districtWindowTerminal = async (provider: ProviderName, districtAdcode: string): Promise<boolean> =>
        await this.resumePage(provider, districtAdcode, maxPagesPerTarget) > maxPagesPerTarget;
      const townshipQueue = async (provider: ProviderName, districtAdcode: string): Promise<Array<{ adcode: string; name: string; page: number }>> => {
        const townships = (await this.addressDb.prepare(`SELECT adcode,name FROM cn_admin_areas
          WHERE parent_adcode=? AND level='township' ORDER BY adcode`).bind(districtAdcode)
          .all<{ adcode: string; name: string }>()).results;
        const queue: Array<{ adcode: string; name: string; page: number }> = [];
        for (const township of townships) {
          const page = await this.resumePage(provider, String(township.adcode), maxPagesPerTarget);
          if (page <= maxPagesPerTarget) queue.push({ adcode: String(township.adcode), name: String(township.name), page });
        }
        return queue;
      };
      // A terminal district window subdivides into per-township keyword queries, each with its
      // own resumable checkpoint keyed by the township adcode; townships advance round-robin so
      // the high-yield first pages of every township are fetched before any deep page.
      const processTownshipRounds = async (provider: ProviderName, target: SyncTarget, phase: 'baseline' | 'enrichment'): Promise<void> => {
        const queue = await townshipQueue(provider, target.id);
        while (queue.length) {
          for (let index = 0; index < queue.length;) {
            if (quotaReached() || (countMet() && !tracker.needsSync(target.id))) return;
            const entry = queue[index];
            const result = await this.fetchPage(provider, target, entry.page, accepted, async () => { requests += 1; }, entry.adcode, entry.name);
            if (!result) {
              unavailable.add(provider);
              return;
            }
            if (result.rawCount === 0) {
              await this.writeCheckpoint(provider, entry.adcode, entry.page, 'exhausted', accepted);
              queue.splice(index, 1);
              continue;
            }
            if (!result.candidates.length) {
              adapterRejectedPages += 1;
              await this.writeCheckpoint(provider, entry.adcode, entry.page, 'adapter_rejected_all', accepted, `raw_count=${result.rawCount}`);
              queue.splice(index, 1);
              continue;
            }
            await processCandidates(result.candidates, target);
            await this.writeCheckpoint(provider, entry.adcode, entry.page + 1, phase, accepted);
            await this.control.updateRun(runId, 'running', { phase, accepted, requests, target: `${target.query}${entry.name}`, provider, page: entry.page });
            entry.page += 1;
            if (entry.page > maxPagesPerTarget) {
              queue.splice(index, 1);
              continue;
            }
            index += 1;
          }
        }
      };
      await this.control.updateRun(runId, 'running', { phase: 'baseline', accepted, requests, target: '', provider: '', page: 0 });
      for (const target of targets) {
        targetIterations += 1;
        if (targetIterations % targetYieldInterval === 0) await yieldEventLoop();
        if (quotaReached()) break;
        if (coverageSkipped(target)) continue;
        for (const provider of providers) {
          if (quotaReached()) break;
          if (unavailable.has(provider)) continue;
          const firstPage = await this.resumePage(provider, target.id, maxPagesPerTarget);
          for (let page = firstPage; page <= maxPagesPerTarget; page += 1) {
            const result = await this.fetchPage(provider, target, page, accepted, async () => { requests += 1; });
            if (!result) {
              unavailable.add(provider);
              break;
            }
            if (result.rawCount === 0) {
              await this.writeCheckpoint(provider, target.id, page, 'exhausted', accepted);
              break;
            }
            if (!result.candidates.length) {
              adapterRejectedPages += 1;
              await this.writeCheckpoint(provider, target.id, page, 'adapter_rejected_all', accepted, `raw_count=${result.rawCount}`);
              break;
            }
            await processCandidates(result.candidates, target);
            await this.writeCheckpoint(provider, target.id, page + 1, 'baseline', accepted);
            await this.control.updateRun(runId, 'running', { phase: 'baseline', accepted, requests, target: target.query, provider, page });
            if (quotaReached()) break;
            if (await currentTargetCount(target) >= target.targetCount) break;
          }
          if (!unavailable.has(provider) && !quotaReached()
            && await currentTargetCount(target) < target.targetCount
            && await districtWindowTerminal(provider, target.id)) {
            await processTownshipRounds(provider, target, 'baseline');
          }
        }
        if (unavailable.size === providers.length) {
          await this.control.updateRun(runId, 'paused_quota', { phase: 'baseline', accepted, requests, target: target.query });
          return;
        }
      }
      if (await this.baselineComplete()) await this.retireLegacyChinaResidential();
      await this.control.updateRun(runId, 'running', { phase: 'enrichment', accepted, requests, target: '', provider: '', page: 0 });
      for (const target of targets) {
        targetIterations += 1;
        if (targetIterations % targetYieldInterval === 0) await yieldEventLoop();
        if (quotaReached()) break;
        if (coverageSkipped(target)) continue;
        for (const provider of providers) {
          if (quotaReached()) break;
          if (unavailable.has(provider)) continue;
          const firstPage = await this.resumePage(provider, target.id, maxPagesPerTarget);
          for (let page = firstPage; page <= maxPagesPerTarget; page += 1) {
            const result = await this.fetchPage(provider, target, page, accepted, async () => { requests += 1; });
            if (!result) { unavailable.add(provider); break; }
            if (result.rawCount === 0) { await this.writeCheckpoint(provider, target.id, page, 'exhausted', accepted); break; }
            if (!result.candidates.length) {
              adapterRejectedPages += 1;
              await this.writeCheckpoint(provider, target.id, page, 'adapter_rejected_all', accepted, `raw_count=${result.rawCount}`);
              break;
            }
            await processCandidates(result.candidates, target);
            await this.writeCheckpoint(provider, target.id, page + 1, 'enrichment', accepted);
            await this.control.updateRun(runId, 'running', { phase: 'enrichment', accepted, requests, target: target.query, provider, page });
            if (quotaReached()) break;
          }
          if (!unavailable.has(provider) && !quotaReached()
            && (!countMet() || tracker.needsSync(target.id))
            && await districtWindowTerminal(provider, target.id)) {
            await processTownshipRounds(provider, target, 'enrichment');
          }
        }
        if (unavailable.size === providers.length) {
          await this.control.updateRun(runId, 'paused_quota', { phase: 'enrichment', accepted, requests, target: target.query });
          return;
        }
      }
      await this.control.updateRun(runId, adapterRejectedPages ? 'needs_review' : 'succeeded', {
        phase: 'complete', accepted, requests, targets: targets.length, providers: providers.length, adapterRejectedPages,
        published: publishedCount
      });
      if (countMet() && !tracker.met()) {
        if (!requests || await this.coverageSourcesExhausted(tracker.uncovered(), providers)) {
          // A completed coverage run without a single request has no page left to fetch
          // from the active provider set; settle instead of rescheduling in seconds.
          this.syncState = 'source_limited';
          this.waitReason = 'coverage_sources_exhausted';
        }
      } else if (!requests && await this.publishedCommunityCount() < countryTarget) {
        this.syncState = 'source_limited';
        this.waitReason = 'validated_sources_exhausted';
      }
    } catch (error) {
      await this.control.updateRun(runId, 'failed', { accepted, requests }, {
        code: error instanceof Error ? error.name : 'SYNC_ERROR', message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await refreshAddressCoverage(this.addressDb).catch(() => undefined);
    }
  }

  private async publishedCommunityCount(): Promise<number> {
    return Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM cn_communities_v2 community
      WHERE ${chinaCommunityPublicationClause('community')}`).first('total') || 0);
  }

  private async targetCount(target: SyncTarget): Promise<number> {
    return Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM cn_communities_v2 community
      WHERE (community.city=? OR (?<>'' AND community.city=? AND community.province=?)) AND (?='' OR community.district=?)
      AND ${chinaCommunityPublicationClause('community')}`)
      .bind(target.city, target.province, target.province, target.province, target.district, target.district)
      .first('total') || 0);
  }

  private async uncoveredTargetCount(): Promise<number> {
    const rows = (await this.addressDb.prepare(`SELECT target.target_count,COUNT(community.id) AS current_count
      FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
      ON ${communityAreaMatch()}
      AND ${chinaCommunityPublicationClause('community')}
      WHERE target.enabled=1 GROUP BY target.adcode,target.target_count
    `).all<{ target_count: number; current_count: number }>()).results;
    return rows.filter((row) => Number(row.current_count) < Number(row.target_count)).length;
  }

  private async areaPublishedCounts(): Promise<ChinaAreaRow[]> {
    const rows = (await this.addressDb.prepare(`SELECT target.adcode AS adcode,target.province,target.city,target.district,
      COUNT(community.id) AS current_count
      FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
      ON ${communityAreaMatch()}
      AND ${chinaCommunityPublicationClause('community')}
      WHERE target.enabled=1 GROUP BY target.adcode,target.province,target.city,target.district`)
      .all<Record<string, unknown>>()).results;
    return rows.map((row) => ({
      adcode: String(row.adcode), province: String(row.province || ''), city: String(row.city || ''),
      district: String(row.district || ''), count: Number(row.current_count || 0)
    }));
  }

  private async chinaNodeOverrides(): Promise<Map<string, number>> {
    const rows = (await this.addressDb.prepare(`SELECT node_key,min_count FROM sync_node_overrides
      WHERE country_code='CN' AND min_count IS NOT NULL`).all<{ node_key: string; min_count: number }>()).results;
    return new Map(rows.map((row) => [String(row.node_key), Number(row.min_count)]));
  }

  private async coverageTracker(policy: CountryPolicy): Promise<ChinaCoverageTracker> {
    return new ChinaCoverageTracker(await this.areaPublishedCounts(), policy, await this.chinaNodeOverrides());
  }

  private async completionState(policy: CountryPolicy): Promise<'incomplete' | 'met'> {
    const published = await this.publishedCommunityCount();
    if (published < policy.targetCount) return 'incomplete';
    return (await this.coverageTracker(policy)).met() ? 'met' : 'incomplete';
  }

  private async pruneOverriddenExcess(): Promise<number> {
    const overrides = (await this.addressDb.prepare(`SELECT node_key,min_count FROM sync_node_overrides
      WHERE country_code='CN' AND min_count IS NOT NULL`).all<{ node_key: string; min_count: number }>()).results;
    let retiredTotal = 0;
    for (const override of overrides) {
      const scope = chinaNodeScope(String(override.node_key));
      if (!scope) continue;
      const filters = Object.entries(scope);
      const where = `${filters.map(([column]) => `community.${column}=?`).join(' AND ')}
        AND ${chinaCommunityPublicationClause('community')}`;
      const bindings = filters.map(([, value]) => value);
      const current = Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM cn_communities_v2 community WHERE ${where}`)
        .bind(...bindings).first('total') || 0);
      const target = Number(override.min_count);
      if (current <= target) continue;
      const excess = current - target;
      const retiredIds = (await this.addressDb.prepare(`SELECT community.id FROM cn_communities_v2 community
        WHERE ${where} ORDER BY community.source_count,community.verification_level,community.last_seen_at,community.id LIMIT ?`)
        .bind(...bindings, excess).all<{ id: string }>()).results.map((row) => row.id);
      if (retiredIds.length) {
        await this.addressDb.prepare(`UPDATE cn_communities_v2 SET active=0,updated_at=?
          WHERE id IN (${retiredIds.map(() => '?').join(',')})`).bind(nowIso(), ...retiredIds).run();
      }
      await this.control.audit('system', 'china.communities.prune', String(override.node_key), { retired: excess, target });
      retiredTotal += excess;
    }
    return retiredTotal;
  }

  private async coverageSourcesExhausted(uncoveredAreas: string[], providers: ProviderName[]): Promise<boolean> {
    if (!uncoveredAreas.length || !providers.length) return false;
    const placeholders = providers.map(() => '?').join(',');
    for (const adcode of uncoveredAreas) {
      // A checkpoint past the page budget is as terminal as an exhausted or rejected one.
      const exhausted = Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM cn_sync_checkpoints
        WHERE city=? AND strategy_version=? AND provider IN (${placeholders})
        AND (status IN ('exhausted','adapter_rejected_all') OR page>?)`)
        .bind(adcode, checkpointStrategyVersion, ...providers, maxPagesPerTarget).first('total') || 0);
      if (exhausted < providers.length) return false;
      // The district only turns terminal once its own window and every township window are
      // consumed; an unqueried township keeps the area eligible for the next run.
      const townships = Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM cn_admin_areas
        WHERE parent_adcode=? AND level='township'`).bind(adcode).first('total') || 0);
      if (!townships) continue;
      const terminalTownshipWindows = Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM cn_admin_areas township
        JOIN cn_sync_checkpoints checkpoint ON checkpoint.city=township.adcode AND checkpoint.strategy_version=?
          AND checkpoint.provider IN (${placeholders})
          AND (checkpoint.status IN ('exhausted','adapter_rejected_all') OR checkpoint.page>?)
        WHERE township.parent_adcode=? AND township.level='township'`)
        .bind(checkpointStrategyVersion, ...providers, maxPagesPerTarget, adcode).first('total') || 0);
      if (terminalTownshipWindows < townships * providers.length) return false;
    }
    return true;
  }

  private async baselineComplete(): Promise<boolean> {
    const targets = Number(await this.addressDb.prepare('SELECT COUNT(*) AS total FROM cn_sync_area_targets WHERE enabled=1').first('total') || 0);
    return targets > 0 && await this.uncoveredTargetCount() === 0;
  }

  private async retireLegacyChinaResidential(): Promise<void> {
    await this.addressDb.prepare(`UPDATE address_pool SET active=0,retired_at=? WHERE country_code='CN' AND active=1
      AND property_type IN ('residential','apartment')`).bind(nowIso()).run();
  }

  private async resumePage(provider: ProviderName, city: string, maxPages: number): Promise<number> {
    const checkpoint = await this.addressDb.prepare(`SELECT page,status,strategy_version FROM cn_sync_checkpoints
      WHERE provider=? AND city=?`).bind(provider, city).first<{ page: number; status: string; strategy_version: string }>();
    if (!checkpoint) return 1;
    if (checkpoint.strategy_version !== checkpointStrategyVersion) return 1;
    if (['exhausted', 'adapter_rejected_all'].includes(checkpoint.status)) return maxPages + 1;
    return Math.max(1, Math.min(maxPages + 1, Math.trunc(checkpoint.page || 1)));
  }

  private async fetchPage(
    provider: ProviderName,
    target: SyncTarget,
    page: number,
    accepted: number,
    requested: () => Promise<void>,
    checkpointKey = '',
    subdivision = ''
  ): Promise<ProviderPage | null> {
    const key = checkpointKey || target.id;
    let lastError = '';
    const attemptedCredentialIds = new Set<string>();
    while (true) {
      const credential = await this.control.acquireCredential(provider, { excludeIds: attemptedCredentialIds });
      if (!credential) {
        if (!attemptedCredentialIds.size) {
          const availability = await this.control.credentialAvailability([provider]);
          if (availability.eligible) continue;
          const waitMs = availability.nextAvailableAt ? Date.parse(availability.nextAvailableAt) - Date.now() : Number.NaN;
          if (availability.reason === 'cooldown' && Number.isFinite(waitMs) && waitMs <= credentialPacingMaxWaitMs) {
            await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(1, waitMs)));
            continue;
          }
        }
        await this.writeCheckpoint(provider, key, page, 'paused', accepted, lastError);
        return null;
      }
      attemptedCredentialIds.add(credential.id);
      try {
        let quotaObservation: ProviderQuotaObservation | undefined;
        const region = provider === 'amap' && /^\d{6}$/u.test(target.id) ? target.id : target.query;
        const result = await providerFetcher[provider](region, page, credential.secret, fetch, (value) => { quotaObservation = value; }, subdivision);
        await requested();
        await this.control.reportCredential(credential.id, 'success', quotaObservation);
        return result;
      } catch (error) {
        await requested();
        const outcome = error instanceof ProviderRequestError ? error.outcome : 'network';
        lastError = error instanceof Error ? error.message : String(error);
        await this.control.reportCredential(credential.id, outcome, error instanceof ProviderRequestError
          ? { retryAt: error.retryAt } : undefined);
        await this.writeCheckpoint(provider, key, page, 'failed', accepted, lastError);
      }
    }
  }

  private async writeCheckpoint(provider: string, city: string, page: number, status: string, accepted: number, error = ''): Promise<void> {
    await this.addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,last_error,updated_at,strategy_version)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider,city) DO UPDATE SET page=excluded.page,status=excluded.status,
      accepted_count=excluded.accepted_count,last_error=excluded.last_error,updated_at=excluded.updated_at,
      strategy_version=excluded.strategy_version`)
      .bind(provider, city, page, status, accepted, error.slice(0, 500) || null, nowIso(), checkpointStrategyVersion).run();
  }

  private async hierarchyValid(candidate: CommunityCandidate, target?: SyncTarget): Promise<boolean> {
    if (target?.city && comparableAdmin(candidate.city) !== comparableAdmin(target.city)
      && comparableAdmin(candidate.city) !== comparableAdmin(target.province)) return false;
    if (target?.district && comparableAdmin(candidate.district) !== comparableAdmin(target.district)) return false;
    if (!candidate.province || !candidate.city || !candidate.district || !candidate.address) return false;
    const count = await this.addressDb.prepare('SELECT COUNT(*) AS total FROM cn_admin_areas').first<number>('total');
    if (!count) return true;
    const province = await this.addressDb.prepare("SELECT adcode FROM cn_admin_areas WHERE level='province' AND name IN (?,?) LIMIT 1")
      .bind(candidate.province, candidate.province.replace(/省$/u, '')).first<{ adcode: string }>();
    if (!province) return false;
    const city = await this.addressDb.prepare("SELECT adcode FROM cn_admin_areas WHERE level='city' AND parent_adcode=? AND name IN (?,?) LIMIT 1")
      .bind(province.adcode, candidate.city, candidate.city.replace(/市$/u, '')).first<{ adcode: string }>();
    if (!city) {
      // Direct municipalities report the province name as the city while AreaCity splits them
      // into pseudo-cities; accept when the district exists under any city of that province.
      if (comparableAdmin(candidate.city) !== comparableAdmin(candidate.province)) return false;
      if (!candidate.district) return false;
      const municipalDistrict = await this.addressDb.prepare(`SELECT district.adcode FROM cn_admin_areas district
        JOIN cn_admin_areas city ON city.adcode=district.parent_adcode AND city.level='city' AND city.parent_adcode=?
        WHERE district.level='district' AND district.name IN (?,?) LIMIT 1`)
        .bind(province.adcode, candidate.district, candidate.district.replace(/[区县]$/u, '')).first<{ adcode: string }>();
      return Boolean(municipalDistrict);
    }
    if (!candidate.district) return true;
    const district = await this.addressDb.prepare(`SELECT adcode FROM cn_admin_areas WHERE level='district' AND parent_adcode=?
      AND name IN (?,?) LIMIT 1`).bind(city.adcode, candidate.district, candidate.district.replace(/[区县]$/u, '')).first<{ adcode: string }>();
    return Boolean(district);
  }

  private async persistCandidate(
    candidate: CommunityCandidate,
    targetAdcode: string,
    decision: 'pending' | 'accepted' | 'rejected',
    rejectionReason = ''
  ): Promise<void> {
    const now = nowIso();
    await this.addressDb.prepare(`INSERT INTO cn_ingest_candidates(provider,provider_poi_id,target_adcode,name,address,province,
      city,district,township,longitude,latitude,raw_longitude,raw_latitude,raw_crs,typecode,adcode,response_hash,decision,
      rejection_reason,strategy_version,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider,provider_poi_id) DO UPDATE SET target_adcode=excluded.target_adcode,name=excluded.name,
      address=excluded.address,province=excluded.province,city=excluded.city,district=excluded.district,
      township=excluded.township,longitude=excluded.longitude,latitude=excluded.latitude,
      raw_longitude=excluded.raw_longitude,raw_latitude=excluded.raw_latitude,raw_crs=excluded.raw_crs,
      typecode=excluded.typecode,adcode=excluded.adcode,response_hash=excluded.response_hash,decision=excluded.decision,
      rejection_reason=excluded.rejection_reason,strategy_version=excluded.strategy_version,last_seen_at=excluded.last_seen_at`).bind(
      candidate.provider, candidate.providerPoiId, targetAdcode, candidate.name, candidate.address, candidate.province,
      candidate.city, candidate.district, candidate.township, candidate.longitude, candidate.latitude,
      candidate.rawLongitude, candidate.rawLatitude, candidate.rawCrs, candidate.typecode, candidate.adcode,
      candidate.responseHash, decision, rejectionReason, checkpointStrategyVersion, now, now
    ).run();
  }

  private async candidateRejectionReason(candidate: CommunityCandidate, target?: SyncTarget): Promise<string> {
    if (!candidate.name) return 'missing_name';
    if (!providerResidentialTypeValid(candidate)) return 'non_residential_provider_type';
    if (!candidate.province || !candidate.city || !candidate.district) return 'missing_administrative_area';
    if (!Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)) return 'invalid_coordinates';
    if (!isChinaDeliveryAddress(candidate.address)) return 'invalid_delivery_address';
    const nonResidential = findNonResidentialMatch({
      countryCode: 'CN', buildingName: candidate.name, formattedAddress: candidate.address
    });
    if (nonResidential.excluded) return `non_residential_${nonResidential.category}`;
    if (matchesCustomBlacklist([candidate.name, candidate.address, candidate.province, candidate.city, candidate.district])) {
      return 'custom_blacklist';
    }
    if (!await this.hierarchyValid(candidate, target)) return 'administrative_mismatch';
    return '';
  }

  private async processCandidate(candidate: CommunityCandidate, target?: SyncTarget): Promise<number> {
    candidate = { ...candidate, address: normalizeChinaProviderAddress(candidate.address, candidate) };
    const targetAdcode = target?.id || candidate.adcode;
    await this.persistCandidate(candidate, targetAdcode, 'pending');
    const rejectionReason = await this.candidateRejectionReason(candidate, target);
    if (rejectionReason) {
      await this.persistCandidate(candidate, targetAdcode, 'rejected', rejectionReason);
      return 0;
    }
    await this.persistCandidate(candidate, targetAdcode, 'accepted');
    return this.upsertCandidate(candidate);
  }

  private async refreshCommunityVerification(communityId: string, lastSeenAt: string | null): Promise<void> {
    const freshSources = Number(await this.addressDb.prepare(`SELECT COUNT(DISTINCT provider) AS total
      FROM cn_community_sources WHERE community_id=? AND ${chinaFreshTimestampClause('last_seen_at')}`)
      .bind(communityId).first<number>('total') || 0);
    const sourceCount = Math.max(1, freshSources);
    const verificationLevel = sourceCount >= 3 ? 'L3' : sourceCount >= 2 ? 'L2' : 'L1';
    await this.addressDb.prepare(`UPDATE cn_communities_v2 SET
      source_count=?,verification_level=?,
      last_seen_at=COALESCE(?,last_seen_at),updated_at=? WHERE id=?`)
      .bind(sourceCount, verificationLevel, lastSeenAt, nowIso(), communityId).run();
  }

  private async upsertCandidate(candidate: CommunityCandidate): Promise<number> {
    const address = normalizeChinaProviderAddress(candidate.address, candidate);
    if (!candidate.name || !providerResidentialTypeValid(candidate) || !isChinaDeliveryAddress(address) || !candidate.province || !candidate.city || !candidate.district
      || !Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)
      || findNonResidentialMatch({ countryCode: 'CN', buildingName: candidate.name, formattedAddress: address }).excluded
      || matchesCustomBlacklist([candidate.name, address, candidate.province, candidate.city, candidate.district])) return 0;
    candidate = { ...candidate, address };
    if (!await this.hierarchyValid(candidate)) return 0;
    const existingSource = await this.addressDb.prepare(`SELECT source.community_id,community.provider_address
      FROM cn_community_sources source JOIN cn_communities_v2 community ON community.id=source.community_id
      WHERE source.provider=? AND source.provider_poi_id=?`)
      .bind(candidate.provider, candidate.providerPoiId).first<{ community_id: string; provider_address: string }>();
    const now = nowIso();
    if (existingSource && addressesAgree(candidate.address, existingSource.provider_address)) {
      await this.addressDb.prepare(`UPDATE cn_community_sources SET raw_name=?,raw_address=?,raw_longitude=?,raw_latitude=?,
        response_hash=?,last_seen_at=? WHERE provider=? AND provider_poi_id=?`).bind(
        candidate.name, candidate.address, candidate.rawLongitude, candidate.rawLatitude, candidate.responseHash, now,
        candidate.provider, candidate.providerPoiId
      ).run();
      await this.refreshCommunityVerification(existingSource.community_id, now);
      return 0;
    }
    const normalized = normalizedName(candidate.name);
    const matches = (await this.addressDb.prepare(`SELECT id,latitude,longitude,provider_address FROM cn_communities_v2
      WHERE city=? AND district=? AND normalized_name=? AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? LIMIT 20`)
      .bind(candidate.city, candidate.district, normalized, candidate.latitude - 0.004, candidate.latitude + 0.004,
        candidate.longitude - 0.004, candidate.longitude + 0.004)
      .all<{ id: string; latitude: number; longitude: number; provider_address: string }>()).results;
    const matched = matches.find((value) => {
      if (distanceMeters(candidate, value) > 300) return false;
      // Missing premise numbers do not confirm a numbered address, and
      // conflicting premise numbers always represent separate candidates.
      return addressesAgree(candidate.address, value.provider_address);
    });
    const communityId = matched?.id || randomUUID();
    if (!matched) {
      await this.addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
        provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'L1',1,?,?,?)`).bind(
        communityId, candidate.name, normalized, candidate.province, candidate.city, candidate.district, candidate.township,
        candidate.address, candidate.longitude, candidate.latitude, now, now, now
      ).run();
    }
    if (existingSource) {
      await this.addressDb.prepare(`UPDATE cn_community_sources SET community_id=?,raw_name=?,raw_address=?,raw_longitude=?,raw_latitude=?,
        raw_crs=?,response_hash=?,last_seen_at=? WHERE provider=? AND provider_poi_id=?`).bind(
        communityId, candidate.name, candidate.address, candidate.rawLongitude, candidate.rawLatitude,
        candidate.rawCrs, candidate.responseHash, now, candidate.provider, candidate.providerPoiId
      ).run();
      await this.refreshCommunityVerification(existingSource.community_id, null);
      const remainingSources = Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total
        FROM cn_community_sources WHERE community_id=?`).bind(existingSource.community_id).first<number>('total') || 0);
      if (!remainingSources) {
        await this.addressDb.prepare('DELETE FROM cn_communities_v2 WHERE id=?').bind(existingSource.community_id).run();
      }
    } else {
      await this.addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        candidate.provider, candidate.providerPoiId, communityId, candidate.name, candidate.address,
        candidate.rawLongitude, candidate.rawLatitude, candidate.rawCrs, candidate.responseHash, now, now
      ).run();
    }
    await this.refreshCommunityVerification(communityId, now);
    return matched ? 0 : 1;
  }

  async importAreaCity(source: string, version: string): Promise<number> {
    const text = await this.readAreaCitySource(source);
    const rows = this.parseAreaCity(text);
    if (!rows.length) throw new Error('AREACITY_DATA_EMPTY');
    const sourceVersion = version.trim().slice(0, 80);
    if (!sourceVersion) throw new Error('INVALID_AREACITY_VERSION');
    await this.addressDb.transaction(async (transaction) => {
      for (const level of ['township', 'district', 'city', 'province']) {
        await transaction.prepare('DELETE FROM cn_admin_areas WHERE level=?').bind(level).run();
      }
      for (let offset = 0; offset < rows.length; offset += 500) {
        await transaction.batch(rows.slice(offset, offset + 500).map((row) => transaction.prepare(`INSERT INTO cn_admin_areas(
          adcode,parent_adcode,level,name,full_path,longitude,latitude,source_version,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
          row.adcode, row.parent, row.level, row.name, row.path, row.longitude, row.latitude, sourceVersion, nowIso()
        )));
      }
    });
    await this.refreshAreaTargets();
    await refreshAddressCoverage(this.addressDb);
    await this.control.audit('admin', 'areacity.import', sourceVersion, { records: rows.length, checksum: createHash('sha256').update(text).digest('hex') });
    return rows.length;
  }

  private parseAreaCity(text: string): AreaRow[] {
    const normalized = text.replace(/^\uFEFF/u, '').trim();
    if (!normalized.startsWith('[') && !normalized.startsWith('{')) return this.parseAreaCityCsv(normalized);
    const payload = JSON.parse(normalized) as AreaNode[] | { data?: AreaNode[] };
    const roots = Array.isArray(payload) ? payload : payload.data || [];
    const rows: AreaRow[] = [];
    const visit = (node: AreaNode, parent: string | null, names: string[], depth: number): void => {
      const adcode = String(node.code ?? node.ext_id ?? node.id ?? '').trim();
      const name = String(node.name || '').trim();
      if (!adcode || !name) return;
      const levels = ['province', 'city', 'district', 'township'];
      const level = typeof node.level === 'string' && levels.includes(node.level) ? node.level : levels[Math.min(depth, 3)];
      const geo = String(node.geo || '').split(',').map(Number);
      const longitude = Number.isFinite(Number(node.longitude)) ? Number(node.longitude) : Number.isFinite(geo[0]) ? geo[0] : null;
      const latitude = Number.isFinite(Number(node.latitude)) ? Number(node.latitude) : Number.isFinite(geo[1]) ? geo[1] : null;
      const path = [...names, name];
      rows.push({ adcode, parent, level, name, path: path.join('/'), longitude, latitude });
      for (const child of node.children || node.child || []) visit(child, adcode, path, depth + 1);
    };
    roots.forEach((root) => visit(root, null, [], 0));
    return rows;
  }

  private parseAreaCityCsv(text: string): AreaRow[] {
    const records = csvRecords(text);
    const headers = (records.shift() || []).map((value) => value.trim().toLowerCase());
    const column = (name: string): number => headers.indexOf(name);
    const idColumn = column('id');
    const parentColumn = column('pid') >= 0 ? column('pid') : column('parent_id');
    const depthColumn = column('deep') >= 0 ? column('deep') : column('level');
    const nameColumn = column('ext_name') >= 0 ? column('ext_name') : column('name');
    if (idColumn < 0 || depthColumn < 0 || nameColumn < 0) throw new Error('INVALID_AREACITY_CSV');
    const levels = ['province', 'city', 'district', 'township'];
    const ancestors: Array<{ id: string; name: string }> = [];
    const rows: AreaRow[] = [];
    for (const record of records) {
      const adcode = String(record[idColumn] || '').trim();
      const name = String(record[nameColumn] || '').trim();
      const depth = Number(record[depthColumn]);
      if (!adcode || !name || !Number.isInteger(depth) || depth < 0 || depth > 3) continue;
      const parentValue = parentColumn >= 0 ? String(record[parentColumn] || '').trim() : '';
      const explicitParent = parentValue === '0' ? '' : parentValue;
      const parent = explicitParent || (depth > 0 ? ancestors[depth - 1]?.id || null : null);
      ancestors.length = depth;
      ancestors[depth] = { id: adcode, name };
      rows.push({
        adcode, parent, level: levels[depth], name,
        path: [...ancestors.slice(0, depth).map((entry) => entry.name), name].join('/'),
        longitude: null, latitude: null
      });
    }
    return rows;
  }

  private async readAreaCitySource(source: string): Promise<string> {
    if (/^https:\/\//iu.test(source)) {
      const response = await fetch(source, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`AREACITY_HTTP_${response.status}`);
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > maxAreaCityBytes) throw new Error('AREACITY_DATA_TOO_LARGE');
      const text = await response.text();
      if (Buffer.byteLength(text) > maxAreaCityBytes) throw new Error('AREACITY_DATA_TOO_LARGE');
      return text;
    }
    if (/^[a-z][a-z\d+.-]*:\/\//iu.test(source)) throw new Error('AREACITY_SOURCE_PROTOCOL');
    const root = resolve(this.dataRoot);
    const path = resolve(root, source);
    const relation = relative(root, path);
    if (!relation || relation.startsWith('..') || isAbsolute(relation)) throw new Error('AREACITY_SOURCE_PATH');
    if ((await stat(path)).size > maxAreaCityBytes) throw new Error('AREACITY_DATA_TOO_LARGE');
    return readFile(path, 'utf8');
  }
}
