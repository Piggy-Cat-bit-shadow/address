import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SqliteDatabase } from '../database/sqlite.mjs';
import { findNonResidentialMatch } from '../../src/domain/non-residential.mjs';
import type { ControlStore, ProviderName } from '../control/store';
import { distanceMeters } from './coordinates';
import { providerFetcher, ProviderRequestError, type CommunityCandidate } from './providers';

export const initialChinaCities = [
  '北京市', '天津市', '上海市', '重庆市', '石家庄市', '太原市', '呼和浩特市', '沈阳市', '长春市', '哈尔滨市',
  '南京市', '杭州市', '合肥市', '福州市', '南昌市', '济南市', '郑州市', '武汉市', '长沙市', '广州市',
  '南宁市', '海口市', '成都市', '贵阳市', '昆明市', '拉萨市', '西安市', '兰州市', '西宁市', '银川市',
  '乌鲁木齐市', '深圳市', '厦门市', '青岛市', '大连市', '宁波市', '苏州市', '唐山市', '无锡市', '佛山市',
  '东莞市', '珠海市', '泉州市'
];

const normalizedName = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('zh-CN')
  .replace(/[·•・\s()（）【】\[\]_-]/gu, '').replace(/(?:小区|社区|花园|公寓|家园|住宅区)$/u, '');
const nowIso = (): string => new Date().toISOString();
const providerNames = ['amap', 'baidu', 'tencent'] as const;
const maxCitiesPerRun = 100;
const maxAreaCityBytes = 128 * 1024 * 1024;

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
  }

  async status(): Promise<Record<string, unknown>> {
    const counts = await this.addressDb.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN verification_level IN ('L2','L3') THEN 1 ELSE 0 END) AS cross_verified,
      COUNT(DISTINCT city) AS cities FROM cn_communities_v2 WHERE active=1`).first<Record<string, unknown>>();
    const sources = (await this.addressDb.prepare('SELECT provider,COUNT(*) AS total FROM cn_community_sources GROUP BY provider ORDER BY provider')
      .all<Record<string, unknown>>()).results;
    const targets = (await this.addressDb.prepare(`SELECT target.city,target.province,target.priority,target.enabled,target.target_count,
      COUNT(community.id) AS current_count FROM cn_sync_targets target LEFT JOIN cn_communities_v2 community
      ON community.city=target.city AND community.active=1 GROUP BY target.city ORDER BY target.priority,target.city`).all<Record<string, unknown>>()).results;
    return { ...counts, sources, targets, running: this.running };
  }

  async start(input: { cities?: string[]; providers?: ProviderName[]; maxPages?: number }): Promise<string> {
    if (this.running) throw new Error('CHINA_SYNC_BUSY');
    const configuredCities = input.cities?.length
      ? input.cities
      : (await this.addressDb.prepare('SELECT city FROM cn_sync_targets WHERE enabled=1 ORDER BY priority,city LIMIT ?')
        .bind(maxCitiesPerRun).all<{ city: string }>()).results.map((row) => row.city);
    if (!Array.isArray(configuredCities)) throw new Error('INVALID_SYNC_CITIES');
    const cities = [...new Set(configuredCities.map((city) => String(city).trim()).filter((city) => city.length > 0 && city.length <= 40))];
    if (!cities.length || cities.length > maxCitiesPerRun) throw new Error('INVALID_SYNC_CITIES');
    const requestedProviders = input.providers?.length ? input.providers : [...providerNames];
    if (!Array.isArray(requestedProviders) || requestedProviders.some((provider) => !providerNames.includes(provider))) {
      throw new Error('INVALID_SYNC_PROVIDERS');
    }
    const providers = [...new Set(requestedProviders)] as ProviderName[];
    const requestedMaxPages = Number(input.maxPages ?? 20);
    if (!Number.isInteger(requestedMaxPages) || requestedMaxPages < 1 || requestedMaxPages > 50) throw new Error('INVALID_SYNC_MAX_PAGES');
    const maxPages = requestedMaxPages;
    const runId = await this.control.createRun('china-communities', { cities, providers, maxPages });
    this.running = true;
    void this.execute(runId, cities, providers, maxPages).finally(() => { this.running = false; });
    return runId;
  }

  private async execute(runId: string, cities: string[], providers: ProviderName[], maxPages: number): Promise<void> {
    let accepted = 0;
    let requests = 0;
    try {
      await this.control.updateRun(runId, 'running', { accepted, requests, city: '', provider: '', page: 0 });
      for (const city of cities) {
        for (const provider of providers) {
          const firstPage = await this.resumePage(provider, city, maxPages);
          for (let page = firstPage; page <= maxPages; page += 1) {
            const candidates = await this.fetchPage(provider, city, page, accepted, async () => { requests += 1; });
            if (!candidates) {
              await this.control.updateRun(runId, 'paused_quota', { accepted, requests, city, provider, page });
              return;
            }
            if (!candidates.length) {
              await this.writeCheckpoint(provider, city, page, 'succeeded', accepted);
              break;
            }
            for (const candidate of candidates) accepted += await this.upsertCandidate(candidate);
            await this.writeCheckpoint(provider, city, page + 1, 'running', accepted);
            await this.control.updateRun(runId, 'running', { accepted, requests, city, provider, page });
            if (page === maxPages) await this.writeCheckpoint(provider, city, page + 1, 'succeeded', accepted);
          }
        }
      }
      await this.control.updateRun(runId, 'succeeded', { accepted, requests, cities: cities.length, providers: providers.length });
    } catch (error) {
      await this.control.updateRun(runId, 'failed', { accepted, requests }, {
        code: error instanceof Error ? error.name : 'SYNC_ERROR', message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async resumePage(provider: ProviderName, city: string, maxPages: number): Promise<number> {
    const checkpoint = await this.addressDb.prepare(`SELECT page,status FROM cn_sync_checkpoints
      WHERE provider=? AND city=?`).bind(provider, city).first<{ page: number; status: string }>();
    if (!checkpoint || checkpoint.status === 'succeeded') return 1;
    return Math.max(1, Math.min(maxPages, Math.trunc(checkpoint.page || 1)));
  }

  private async fetchPage(
    provider: ProviderName,
    city: string,
    page: number,
    accepted: number,
    requested: () => Promise<void>
  ): Promise<CommunityCandidate[] | null> {
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const credential = await this.control.acquireCredential(provider);
      if (!credential) {
        await this.writeCheckpoint(provider, city, page, 'paused', accepted, lastError);
        return null;
      }
      try {
        const candidates = await providerFetcher[provider](city, page, credential.secret);
        await requested();
        await this.control.reportCredential(credential.id, 'success');
        return candidates;
      } catch (error) {
        await requested();
        const outcome = error instanceof ProviderRequestError ? error.outcome : 'network';
        lastError = error instanceof Error ? error.message : String(error);
        await this.control.reportCredential(credential.id, outcome);
        await this.writeCheckpoint(provider, city, page, 'failed', accepted, lastError);
      }
    }
    throw new Error(`PROVIDER_PAGE_RETRY_EXHAUSTED:${provider}:${city}:${page}:${lastError}`);
  }

  private async writeCheckpoint(provider: string, city: string, page: number, status: string, accepted: number, error = ''): Promise<void> {
    await this.addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,last_error,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,city) DO UPDATE SET page=excluded.page,status=excluded.status,
      accepted_count=excluded.accepted_count,last_error=excluded.last_error,updated_at=excluded.updated_at`)
      .bind(provider, city, page, status, accepted, error.slice(0, 500) || null, nowIso()).run();
  }

  private async hierarchyValid(candidate: CommunityCandidate): Promise<boolean> {
    const count = await this.addressDb.prepare('SELECT COUNT(*) AS total FROM cn_admin_areas').first<number>('total');
    if (!count) return true;
    const city = await this.addressDb.prepare("SELECT adcode FROM cn_admin_areas WHERE level='city' AND name IN (?,?) LIMIT 1")
      .bind(candidate.city, candidate.city.replace(/市$/u, '')).first<{ adcode: string }>();
    if (!city) return false;
    if (!candidate.district) return true;
    const district = await this.addressDb.prepare(`SELECT adcode FROM cn_admin_areas WHERE level='district' AND parent_adcode=?
      AND name IN (?,?) LIMIT 1`).bind(city.adcode, candidate.district, candidate.district.replace(/[区县]$/u, '')).first<{ adcode: string }>();
    return Boolean(district);
  }

  private async upsertCandidate(candidate: CommunityCandidate): Promise<number> {
    if (!candidate.name || findNonResidentialMatch({ countryCode: 'CN', buildingName: candidate.name }).excluded) return 0;
    if (!await this.hierarchyValid(candidate)) return 0;
    const existingSource = await this.addressDb.prepare('SELECT community_id FROM cn_community_sources WHERE provider=? AND provider_poi_id=?')
      .bind(candidate.provider, candidate.providerPoiId).first<{ community_id: string }>();
    const now = nowIso();
    if (existingSource) {
      await this.addressDb.prepare(`UPDATE cn_community_sources SET raw_name=?,raw_address=?,raw_longitude=?,raw_latitude=?,
        response_hash=?,last_seen_at=? WHERE provider=? AND provider_poi_id=?`).bind(
        candidate.name, candidate.address, candidate.rawLongitude, candidate.rawLatitude, candidate.responseHash, now,
        candidate.provider, candidate.providerPoiId
      ).run();
      await this.addressDb.prepare('UPDATE cn_communities_v2 SET last_seen_at=?,updated_at=? WHERE id=?')
        .bind(now, now, existingSource.community_id).run();
      return 0;
    }
    const normalized = normalizedName(candidate.name);
    const matches = (await this.addressDb.prepare(`SELECT id,latitude,longitude FROM cn_communities_v2
      WHERE city=? AND district=? AND normalized_name=? AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? LIMIT 20`)
      .bind(candidate.city, candidate.district, normalized, candidate.latitude - 0.004, candidate.latitude + 0.004,
        candidate.longitude - 0.004, candidate.longitude + 0.004).all<{ id: string; latitude: number; longitude: number }>()).results;
    const matched = matches.find((value) => distanceMeters(candidate, value) <= 300);
    const communityId = matched?.id || randomUUID();
    if (!matched) {
      await this.addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
        provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'L1',1,?,?,?)`).bind(
        communityId, candidate.name, normalized, candidate.province, candidate.city, candidate.district, candidate.township,
        candidate.address, candidate.longitude, candidate.latitude, now, now, now
      ).run();
    }
    await this.addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
      raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      candidate.provider, candidate.providerPoiId, communityId, candidate.name, candidate.address,
      candidate.rawLongitude, candidate.rawLatitude, candidate.rawCrs, candidate.responseHash, now, now
    ).run();
    await this.addressDb.prepare(`UPDATE cn_communities_v2 SET source_count=(SELECT COUNT(*) FROM cn_community_sources WHERE community_id=?),
      verification_level=CASE WHEN (SELECT COUNT(*) FROM cn_community_sources WHERE community_id=?)>=3 THEN 'L3'
        WHEN (SELECT COUNT(*) FROM cn_community_sources WHERE community_id=?)>=2 THEN 'L2' ELSE 'L1' END,
      last_seen_at=?,updated_at=? WHERE id=?`).bind(communityId, communityId, communityId, now, now, communityId).run();
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
