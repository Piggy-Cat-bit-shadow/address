import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SqliteDatabase } from '../database/sqlite.mjs';
import { findNonResidentialMatch } from '../../src/domain/non-residential.mjs';
import type { ControlStore, ProviderName, ProviderQuotaObservation } from '../control/store';
import { refreshAddressCoverage } from '../control/coverage';
import {
  chinaCommunityPublicationClause,
  chinaFreshSourceCountClause,
  chinaFreshTimestampClause
} from '../api/repositories/china-community';
import { distanceMeters } from './coordinates';
import { providerFetcher, ProviderRequestError, type CommunityCandidate } from './providers';
import { getCountryPolicy } from '../sync/address-policy.mjs';

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
const nowIso = (): string => new Date().toISOString();
const providerNames = ['amap', 'baidu', 'tencent'] as const;
const maxPagesPerTarget = 8;
const maxAreaCityBytes = 128 * 1024 * 1024;
const credentialRetryDelayMs = 400;

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

interface SyncTarget {
  id: string;
  province: string;
  city: string;
  district: string;
  query: string;
  targetCount: number;
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

  constructor(
    private readonly addressDb: SqliteDatabase,
    private readonly control: ControlStore,
    private readonly dataRoot = resolve('data')
  ) {}

  async initializeTargets(): Promise<void> {
    const now = nowIso();
    await this.addressDb.batch(initialChinaCities.map((city, index) => this.addressDb.prepare(`INSERT OR IGNORE INTO cn_sync_targets(
      city,province,priority,enabled,target_count,updated_at) VALUES (?,?,?,1,?,?)`).bind(city, '', index + 1, index < 31 ? 800 : 500, now)));
    await this.refreshAreaTargets();
    await this.reconcileCommunityVerification();
  }

  private async reconcileCommunityVerification(): Promise<void> {
    const freshSources = chinaFreshSourceCountClause('cn_communities_v2', 'fresh_source');
    await this.addressDb.prepare(`UPDATE cn_communities_v2 SET
      source_count=MAX(1,${freshSources}),
      verification_level=CASE
        WHEN ${freshSources}>=3 THEN 'L3'
        WHEN ${freshSources}>=2 THEN 'L2'
        ELSE 'L1' END,
      updated_at=?
      WHERE EXISTS (SELECT 1 FROM cn_community_sources source WHERE source.community_id=cn_communities_v2.id)`).bind(nowIso()).run();
  }

  private async refreshAreaTargets(): Promise<void> {
    await this.addressDb.prepare(`INSERT INTO cn_sync_area_targets(adcode,province,city,district,query,target_count,priority,enabled,updated_at)
      SELECT district.adcode,province.name,city.name,district.name,city.name||district.name,10,CAST(district.adcode AS INTEGER),1,?
      FROM cn_admin_areas district JOIN cn_admin_areas city ON city.adcode=district.parent_adcode
      JOIN cn_admin_areas province ON province.adcode=city.parent_adcode WHERE district.level='district'
      ON CONFLICT(adcode) DO UPDATE SET province=excluded.province,city=excluded.city,district=excluded.district,
        query=excluded.query,priority=excluded.priority,updated_at=excluded.updated_at`).bind(nowIso()).run();
  }

  async status(): Promise<Record<string, unknown>> {
    const counts = await this.addressDb.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN source_count>=2 THEN 1 ELSE 0 END),0) AS cross_verified,
      COUNT(DISTINCT city) AS cities FROM cn_communities_v2 community
      WHERE ${chinaCommunityPublicationClause('community')}`).first<Record<string, unknown>>();
    const sources = (await this.addressDb.prepare(`SELECT source.provider,COUNT(*) AS total FROM cn_community_sources source
      JOIN cn_communities_v2 community ON community.id=source.community_id
      WHERE ${chinaCommunityPublicationClause('community')} AND ${chinaFreshTimestampClause('source.last_seen_at')}
      GROUP BY source.provider ORDER BY source.provider`)
      .all<Record<string, unknown>>()).results;
    let coverage = await this.addressDb.prepare(`SELECT COUNT(*) AS districts_total,
      SUM(CASE WHEN current_count>=target_count THEN 1 ELSE 0 END) AS districts_covered,
      SUM(MAX(target_count-current_count,0)) AS communities_needed FROM (
        SELECT target.adcode,target.target_count,COUNT(community.id) AS current_count
        FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
          ON community.city=target.city AND community.district=target.district
          AND ${chinaCommunityPublicationClause('community')}
        WHERE target.enabled=1 GROUP BY target.adcode
      )`).first<Record<string, unknown>>();
    let areas = (await this.addressDb.prepare(`SELECT target.province,target.city,target.district,target.target_count,
      COUNT(community.id) AS current_count FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
      ON community.city=target.city AND community.district=target.district
      AND ${chinaCommunityPublicationClause('community')}
      WHERE target.enabled=1 GROUP BY target.adcode ORDER BY current_count,target.priority LIMIT 100`).all<Record<string, unknown>>()).results;
    const usingFallback = Number(coverage?.districts_total || 0) === 0;
    if (usingFallback) {
      areas = (await this.addressDb.prepare(`SELECT target.province,target.city,'重点城市' AS district,10 AS target_count,
        COUNT(community.id) AS current_count FROM cn_sync_targets target LEFT JOIN cn_communities_v2 community
        ON community.city=target.city AND ${chinaCommunityPublicationClause('community')}
        WHERE target.enabled=1
        GROUP BY target.city ORDER BY current_count,target.priority LIMIT 100`).all<Record<string, unknown>>()).results;
      coverage = {
        districts_total: areas.length,
        districts_covered: areas.filter((area) => Number(area.current_count || 0) >= 10).length,
        communities_needed: areas.reduce((total, area) => total + Math.max(10 - Number(area.current_count || 0), 0), 0)
      };
    }
    const credentials = (await this.control.listCredentials()).filter((item) => item.enabled && item.status === 'healthy');
    const remaining = Number(coverage?.communities_needed || 0);
    const estimatedRequests = Math.ceil(remaining / 20);
    const activeKeys = credentials.length;
    const estimatedMinutes = activeKeys ? Math.max(1, Math.ceil(estimatedRequests / activeKeys / 60)) : null;
    return { ...counts, sources, coverage, areas, usingFallback, running: this.running,
      estimate: { remainingCommunities: remaining, estimatedRequests, activeKeys, estimatedMinutes } };
  }

  async start(_input: { cities?: string[]; providers?: ProviderName[]; maxPages?: number } = {}): Promise<string> {
    if (this.running) throw new Error('CHINA_SYNC_BUSY');
    await this.refreshAreaTargets();
    const rows = (await this.addressDb.prepare(`SELECT target.adcode AS id,target.province,target.city,target.district,target.query,
      target.target_count FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
      ON community.city=target.city AND community.district=target.district
      AND ${chinaCommunityPublicationClause('community')}
      WHERE target.enabled=1 GROUP BY target.adcode ORDER BY COUNT(community.id),target.priority`).all<Record<string, unknown>>()).results;
    const targets: SyncTarget[] = rows.map((row) => ({
      id: String(row.id), province: String(row.province), city: String(row.city), district: String(row.district),
      query: String(row.query), targetCount: Number(row.target_count)
    }));
    if (!targets.length) {
      targets.push(...initialChinaCities.map((city) => ({ id: city, province: '', city, district: '', query: city, targetCount: 10 })));
    }
    const providers = (await this.control.availableProviders()).filter((provider) => providerNames.includes(provider));
    if (!providers.length) throw new Error('NO_AVAILABLE_KEY');
    const runId = await this.control.createRun('china-communities', { mode: 'automatic', targets: targets.length, providers });
    this.running = true;
    void this.execute(runId, targets, providers).finally(() => { this.running = false; });
    return runId;
  }

  private async execute(runId: string, targets: SyncTarget[], providers: ProviderName[]): Promise<void> {
    let accepted = 0;
    let requests = 0;
    const unavailable = new Set<ProviderName>();
    try {
      const policy = await getCountryPolicy(this.addressDb, 'CN');
      if (!policy.enabled) {
        await this.control.updateRun(runId, 'succeeded', { phase: 'disabled', accepted, requests, targets: 0, providers: 0 });
        return;
      }
      const countryTarget = policy.targetCount;
      const quotaReached = async () => await this.publishedCommunityCount() >= countryTarget;
      await this.control.updateRun(runId, 'running', { phase: 'baseline', accepted, requests, target: '', provider: '', page: 0 });
      for (const target of targets) {
        if (await quotaReached()) break;
        for (const provider of providers) {
          if (await quotaReached()) break;
          if (unavailable.has(provider)) continue;
          const firstPage = await this.resumePage(provider, target.id, maxPagesPerTarget);
          for (let page = firstPage; page <= maxPagesPerTarget; page += 1) {
            const candidates = await this.fetchPage(provider, target, page, accepted, async () => { requests += 1; });
            if (!candidates) {
              unavailable.add(provider);
              break;
            }
            if (!candidates.length) {
              await this.writeCheckpoint(provider, target.id, page, 'exhausted', accepted);
              break;
            }
            for (const candidate of candidates) {
              if (await this.hierarchyValid(candidate, target)) accepted += await this.upsertCandidate(candidate);
            }
            await this.writeCheckpoint(provider, target.id, page + 1, 'baseline', accepted);
            await this.control.updateRun(runId, 'running', { phase: 'baseline', accepted, requests, target: target.query, provider, page });
            if (await quotaReached()) break;
            if (await this.targetCount(target) >= target.targetCount) break;
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
        if (await quotaReached()) break;
        for (const provider of providers) {
          if (await quotaReached()) break;
          if (unavailable.has(provider)) continue;
          const firstPage = await this.resumePage(provider, target.id, maxPagesPerTarget);
          for (let page = firstPage; page <= maxPagesPerTarget; page += 1) {
            const candidates = await this.fetchPage(provider, target, page, accepted, async () => { requests += 1; });
            if (!candidates) { unavailable.add(provider); break; }
            if (!candidates.length) { await this.writeCheckpoint(provider, target.id, page, 'exhausted', accepted); break; }
            for (const candidate of candidates) {
              if (await this.hierarchyValid(candidate, target)) accepted += await this.upsertCandidate(candidate);
            }
            await this.writeCheckpoint(provider, target.id, page + 1, 'enrichment', accepted);
            await this.control.updateRun(runId, 'running', { phase: 'enrichment', accepted, requests, target: target.query, provider, page });
            if (await quotaReached()) break;
          }
        }
        if (unavailable.size === providers.length) {
          await this.control.updateRun(runId, 'paused_quota', { phase: 'enrichment', accepted, requests, target: target.query });
          return;
        }
      }
      await this.control.updateRun(runId, 'succeeded', { phase: 'complete', accepted, requests, targets: targets.length, providers: providers.length });
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
      WHERE city=? AND (?='' OR district=?) AND ${chinaCommunityPublicationClause('community')}`)
      .bind(target.city, target.district, target.district).first('total') || 0);
  }

  private async uncoveredTargetCount(): Promise<number> {
    return Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM (
      SELECT target.adcode,target.target_count,COUNT(community.id) AS current_count
      FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
      ON community.city=target.city AND community.district=target.district
      AND ${chinaCommunityPublicationClause('community')}
      WHERE target.enabled=1 GROUP BY target.adcode HAVING current_count<target.target_count
    )`).first('total') || 0);
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
    const checkpoint = await this.addressDb.prepare(`SELECT page,status FROM cn_sync_checkpoints
      WHERE provider=? AND city=?`).bind(provider, city).first<{ page: number; status: string }>();
    if (!checkpoint) return 1;
    if (checkpoint.status === 'exhausted') return maxPages + 1;
    return Math.max(1, Math.min(maxPages + 1, Math.trunc(checkpoint.page || 1)));
  }

  private async fetchPage(
    provider: ProviderName,
    target: SyncTarget,
    page: number,
    accepted: number,
    requested: () => Promise<void>
  ): Promise<CommunityCandidate[] | null> {
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const credential = await this.control.acquireCredential(provider);
      if (!credential) {
        if (attempt < 3) {
          await new Promise((resolveWait) => setTimeout(resolveWait, credentialRetryDelayMs));
          continue;
        }
        await this.writeCheckpoint(provider, target.id, page, 'paused', accepted, lastError);
        return null;
      }
      try {
        let quotaObservation: ProviderQuotaObservation | undefined;
        const region = provider === 'amap' && /^\d{6}$/u.test(target.id) ? target.id : target.query;
        const candidates = await providerFetcher[provider](region, page, credential.secret, fetch, (value) => { quotaObservation = value; });
        await requested();
        await this.control.reportCredential(credential.id, 'success', quotaObservation);
        return candidates;
      } catch (error) {
        await requested();
        const outcome = error instanceof ProviderRequestError ? error.outcome : 'network';
        lastError = error instanceof Error ? error.message : String(error);
        await this.control.reportCredential(credential.id, outcome);
        await this.writeCheckpoint(provider, target.id, page, 'failed', accepted, lastError);
      }
    }
    throw new Error(`PROVIDER_PAGE_RETRY_EXHAUSTED:${provider}:${target.id}:${page}:${lastError}`);
  }

  private async writeCheckpoint(provider: string, city: string, page: number, status: string, accepted: number, error = ''): Promise<void> {
    await this.addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,last_error,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,city) DO UPDATE SET page=excluded.page,status=excluded.status,
      accepted_count=excluded.accepted_count,last_error=excluded.last_error,updated_at=excluded.updated_at`)
      .bind(provider, city, page, status, accepted, error.slice(0, 500) || null, nowIso()).run();
  }

  private async hierarchyValid(candidate: CommunityCandidate, target?: SyncTarget): Promise<boolean> {
    if (target?.city && comparableAdmin(candidate.city) !== comparableAdmin(target.city)) return false;
    if (target?.district && comparableAdmin(candidate.district) !== comparableAdmin(target.district)) return false;
    if (!candidate.province || !candidate.city || !candidate.district || !candidate.address) return false;
    const count = await this.addressDb.prepare('SELECT COUNT(*) AS total FROM cn_admin_areas').first<number>('total');
    if (!count) return true;
    const province = await this.addressDb.prepare("SELECT adcode FROM cn_admin_areas WHERE level='province' AND name IN (?,?) LIMIT 1")
      .bind(candidate.province, candidate.province.replace(/省$/u, '')).first<{ adcode: string }>();
    if (!province) return false;
    const city = await this.addressDb.prepare("SELECT adcode FROM cn_admin_areas WHERE level='city' AND parent_adcode=? AND name IN (?,?) LIMIT 1")
      .bind(province.adcode, candidate.city, candidate.city.replace(/市$/u, '')).first<{ adcode: string }>();
    if (!city) return false;
    if (!candidate.district) return true;
    const district = await this.addressDb.prepare(`SELECT adcode FROM cn_admin_areas WHERE level='district' AND parent_adcode=?
      AND name IN (?,?) LIMIT 1`).bind(city.adcode, candidate.district, candidate.district.replace(/[区县]$/u, '')).first<{ adcode: string }>();
    return Boolean(district);
  }

  private async refreshCommunityVerification(communityId: string, lastSeenAt: string | null): Promise<void> {
    const freshSources = chinaFreshSourceCountClause('cn_communities_v2', 'fresh_source');
    await this.addressDb.prepare(`UPDATE cn_communities_v2 SET
      source_count=MAX(1,${freshSources}),
      verification_level=CASE WHEN ${freshSources}>=3 THEN 'L3'
        WHEN ${freshSources}>=2 THEN 'L2' ELSE 'L1' END,
      last_seen_at=COALESCE(?,last_seen_at),updated_at=? WHERE id=?`)
      .bind(lastSeenAt, nowIso(), communityId).run();
  }

  private async upsertCandidate(candidate: CommunityCandidate): Promise<number> {
    if (!candidate.name || !candidate.address || !candidate.province || !candidate.city || !candidate.district
      || !Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)
      || findNonResidentialMatch({ countryCode: 'CN', buildingName: candidate.name }).excluded) return 0;
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
      await this.addressDb.prepare(`DELETE FROM cn_communities_v2 WHERE id=?
        AND NOT EXISTS (SELECT 1 FROM cn_community_sources source WHERE source.community_id=cn_communities_v2.id)`)
        .bind(existingSource.community_id).run();
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
    await this.addressDb.exec('BEGIN IMMEDIATE');
    try {
      await this.addressDb.prepare('DELETE FROM cn_admin_areas').run();
      for (let offset = 0; offset < rows.length; offset += 500) {
        await this.addressDb.batch(rows.slice(offset, offset + 500).map((row) => this.addressDb.prepare(`INSERT INTO cn_admin_areas(
          adcode,parent_adcode,level,name,full_path,longitude,latitude,source_version,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
          row.adcode, row.parent, row.level, row.name, row.path, row.longitude, row.latitude, sourceVersion, nowIso()
        )));
      }
      await this.addressDb.exec('COMMIT');
    } catch (error) {
      await this.addressDb.exec('ROLLBACK');
      throw error;
    }
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
