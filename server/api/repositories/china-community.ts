import { createHash } from 'node:crypto';
import { pinyin } from 'pinyin-pro';
import type { Database } from '../../database/database.mjs';
import type { AddressComponents, AddressEvidence, VerifiedAddress } from '../../../src/domain/types';
import type { AddressFilters } from './address-repository';
import { matchesCustomBlacklist } from '../../lib/custom-blacklist.mjs';
import { chinaDeliveryAddressClause, normalizeChinaProviderAddress } from '../../china/quality';

interface CommunityCandidateRow {
  id: string; canonical_name: string; province: string; city: string; district: string; township: string;
  provider_address: string; latitude: number; longitude: number; verification_level: 'L1' | 'L2' | 'L3';
  source_count: number; last_seen_at: string;
}

interface CommunityRow extends CommunityCandidateRow { providers: string }

const loadCommunityProviders = async (database: Database, communityId: string): Promise<string> => {
  const rows = (await database.prepare(`SELECT DISTINCT provider FROM cn_community_sources
    WHERE community_id=? AND ${chinaFreshTimestampClause('last_seen_at')} ORDER BY provider`)
    .bind(communityId).all<{ provider: string }>()).results;
  return rows.map((row) => row.provider).join(',');
};

export const CHINA_COMMUNITY_VALIDITY_DAYS = 180;
export const chinaFreshTimestampClause = (column: string): string =>
  `${column}::timestamptz > CURRENT_TIMESTAMP - INTERVAL '${CHINA_COMMUNITY_VALIDITY_DAYS} days'`;
export const chinaFreshSourceCountClause = (communityAlias = 'community', sourceAlias = 'fresh_source'): string => `(
  SELECT COUNT(DISTINCT ${sourceAlias}.provider) FROM cn_community_sources ${sourceAlias}
  WHERE ${sourceAlias}.community_id=${communityAlias}.id AND ${chinaFreshTimestampClause(`${sourceAlias}.last_seen_at`)}
)`;
export const chinaCommunityPublicationClause = (alias = 'community'): string => [
  `${alias}.active=1`,
  chinaFreshTimestampClause(`${alias}.last_seen_at`),
  chinaDeliveryAddressClause(alias),
  `${alias}.id IN (SELECT publication_source.community_id FROM cn_community_sources publication_source
    LEFT JOIN cn_ingest_candidates strict_candidate
      ON strict_candidate.provider=publication_source.provider
      AND strict_candidate.provider_poi_id=publication_source.provider_poi_id
      AND strict_candidate.decision='accepted'
      AND strict_candidate.strategy_version IN ('community-poi-v6','community-poi-v7')
    WHERE ${chinaFreshTimestampClause('publication_source.last_seen_at')}
      AND (publication_source.provider='amap' OR strict_candidate.provider IS NOT NULL))`
].join(' AND ');

const seedIndex = (seed: string, length: number): number => Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % length;
const CANDIDATE_CACHE_TTL_MS = 30_000;
const CANDIDATE_CACHE_LIMIT = 250;
interface CandidateCacheEntry { expiresAt: number; promise: Promise<CommunityCandidateRow[]> }
const candidateCaches = new WeakMap<object, Map<string, CandidateCacheEntry>>();
const candidateCacheFor = (database: Database): Map<string, CandidateCacheEntry> => {
  let cache = candidateCaches.get(database as object);
  if (!cache) {
    cache = new Map();
    candidateCaches.set(database as object, cache);
  }
  return cache;
};
const communityDistanceKm = (left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }): number => {
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, value))), Math.sqrt(Math.max(0, 1 - value)));
};
const MAX_COMMUNITY_DISTANCE_KM = 25;
const romanize = (value: string): string => pinyin(value, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
  .map((part) => part.trim()).filter(Boolean).join(' ').replace(/^\p{Ll}/u, (value) => value.toUpperCase());
const providerHome: Record<string, string> = {
  amap: 'https://www.amap.com/', baidu: 'https://map.baidu.com/', tencent: 'https://map.qq.com/'
};
const providerName: Record<string, string> = { amap: '高德地图', baidu: '百度地图', tencent: '腾讯地图' };

const rowToAddress = (row: CommunityRow): VerifiedAddress => {
  const providerAddress = normalizeChinaProviderAddress(row.provider_address, row);
  const native: AddressComponents = {
    houseNumber: '', street: providerAddress, buildingName: row.canonical_name,
    locality: row.city, postalLocality: row.city, district: row.district,
    ...(row.township ? { dependentLocality: row.township } : {}), admin1: row.province, postcode: ''
  };
  const english: AddressComponents = {
    ...native,
    street: romanize(providerAddress), buildingName: romanize(row.canonical_name), locality: romanize(row.city),
    postalLocality: romanize(row.city), district: romanize(row.district),
    ...(row.township ? { dependentLocality: romanize(row.township) } : {}), admin1: romanize(row.province)
  };
  const nativeAddress = `${row.province}${row.city}${row.district}${row.township}${providerAddress}${row.canonical_name}`;
  const englishAddress = [english.buildingName, english.street, english.dependentLocality, english.district, english.locality, english.admin1, 'China']
    .filter(Boolean).join(', ');
  const evidence: AddressEvidence[] = [...new Set(row.providers.split(',').filter(Boolean))].flatMap((provider) => {
    const sourceUrl = providerHome[provider] || '';
    const common = { sourceId: provider, sourceName: providerName[provider] || provider, sourceUrl, sourceFamily: provider, observedAt: row.last_seen_at };
    return [
      { ...common, type: 'address_existence' as const, value: nativeAddress },
      { ...common, type: 'coordinate' as const, value: `${row.latitude},${row.longitude}` },
      { ...common, type: 'residential_use' as const, value: row.canonical_name }
    ];
  });
  return {
    id: `cn-community-${row.id}`,
    countryCode: 'CN',
    nativeAddress,
    formattedAddress: englishAddress,
    nativeLanguage: 'zh-CN',
    addressVariants: { native: nativeAddress, en: englishAddress, 'zh-CN': nativeAddress },
    components: native,
    componentVariants: { native, en: english, 'zh-CN': { ...native } },
    coordinates: { latitude: row.latitude, longitude: row.longitude },
    addressStatus: 'verified',
    propertyType: 'apartment',
    unitStatus: 'building_only',
    unitProvenance: 'none',
    matchLevel: 'premise',
    verificationLevel: row.verification_level,
    sourceVersion: `map-poi-${row.last_seen_at.slice(0, 10)}`,
    sourceUpdatedAt: row.last_seen_at.slice(0, 10),
    verifiedAt: row.last_seen_at,
    expiresAt: new Date(new Date(row.last_seen_at).getTime() + 180 * 86400000).toISOString(),
    evidence,
    exclusionFlags: []
  };
};

export const countChinaCommunities = async (database?: Database): Promise<number> => {
  if (!database) return 0;
  try {
    return Number(await database.prepare(`SELECT COUNT(*) AS total FROM cn_communities_v2 community
      WHERE ${chinaCommunityPublicationClause('community')}`).first('total') || 0);
  }
  catch { return 0; }
};

export const loadChinaCommunityAddressById = async (
  database: Database | undefined,
  addressId: string
): Promise<VerifiedAddress | undefined> => {
  if (!database || !addressId.startsWith('cn-community-')) return undefined;
  const communityId = addressId.slice('cn-community-'.length).split(':')[0];
  try {
    const row = await database.prepare(`SELECT community.* FROM cn_communities_v2 community
      WHERE community.id=? AND ${chinaCommunityPublicationClause('community')}
      LIMIT 1`).bind(communityId).first<CommunityCandidateRow>();
    if (!row) return undefined;
    const providers = await loadCommunityProviders(database, row.id);
    return providers ? rowToAddress({ ...row, providers }) : undefined;
  } catch (error) {
    if (process.env.NODE_ENV === 'test') throw error;
    return undefined;
  }
};

export const pickChinaCommunityAddress = async (
  database: Database | undefined,
  filters: AddressFilters,
  seed: string,
  coordinates?: { latitude: number; longitude: number }
): Promise<VerifiedAddress | undefined> => {
  if (!database) return undefined;
  const clauses = [chinaCommunityPublicationClause('community')];
  const bindings: unknown[] = [];
  if (filters.region) { clauses.push('(community.province=? OR REPLACE(community.province,\'省\',\'\')=REPLACE(?,\'省\',\'\'))'); bindings.push(filters.region, filters.region); }
  if (filters.city) { clauses.push('(community.city=? OR REPLACE(community.city,\'市\',\'\')=REPLACE(?,\'市\',\'\'))'); bindings.push(filters.city, filters.city); }
  if (filters.district) { clauses.push('(community.district=? OR REPLACE(community.district,\'区\',\'\')=REPLACE(?,\'区\',\'\'))'); bindings.push(filters.district, filters.district); }
  if (filters.q) { clauses.push('(community.canonical_name LIKE ? OR community.provider_address LIKE ?)'); bindings.push(`%${filters.q}%`, `%${filters.q}%`); }
  if (coordinates) {
    clauses.push('community.latitude BETWEEN ? AND ?', 'community.longitude BETWEEN ? AND ?');
    bindings.push(coordinates.latitude - 1, coordinates.latitude + 1, coordinates.longitude - 1, coordinates.longitude + 1);
  }
  let rows: CommunityCandidateRow[];
  try {
    const loadCandidates = () => database.prepare(`SELECT community.* FROM cn_communities_v2 community
      WHERE ${clauses.join(' AND ')} ORDER BY community.source_count DESC,community.id LIMIT 500`)
      .bind(...bindings).all<CommunityCandidateRow>().then((result) => result.results);
    if (coordinates) rows = await loadCandidates();
    else {
      const cache = candidateCacheFor(database);
      const key = JSON.stringify([filters.region || '', filters.city || '', filters.district || '', filters.q || '']);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) rows = await cached.promise;
      else {
        if (cache.size >= CANDIDATE_CACHE_LIMIT) {
          const now = Date.now();
          for (const [cacheKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(cacheKey);
          if (cache.size >= CANDIDATE_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
        }
        const promise = loadCandidates();
        const entry = { expiresAt: Number.POSITIVE_INFINITY, promise };
        cache.set(key, entry);
        void promise.then(() => {
          if (cache.get(key)?.promise === promise) entry.expiresAt = Date.now() + CANDIDATE_CACHE_TTL_MS;
        }, () => {
          if (cache.get(key)?.promise === promise) cache.delete(key);
        });
        rows = await promise;
      }
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'test') throw error;
    return undefined;
  }
  if (!rows.length) return undefined;
  const allowedRows = rows.filter((row) => !matchesCustomBlacklist([
    row.canonical_name, row.provider_address, row.province, row.city, row.district
  ]));
  const coordinateRows = coordinates
    ? allowedRows.map((row) => ({ row, distanceKm: communityDistanceKm(coordinates, row) }))
      .filter((candidate) => candidate.distanceKm <= MAX_COMMUNITY_DISTANCE_KM)
      .sort((left, right) => left.distanceKm - right.distanceKm)
      .map(({ row }) => row)
    : allowedRows;
  if (!coordinateRows.length) return undefined;
  const selected = coordinates ? coordinateRows[0] : coordinateRows[seedIndex(seed, coordinateRows.length)];
  try {
    const providers = await loadCommunityProviders(database, selected.id);
    return providers ? rowToAddress({ ...selected, providers }) : undefined;
  } catch (error) {
    if (process.env.NODE_ENV === 'test') throw error;
    return undefined;
  }
};
