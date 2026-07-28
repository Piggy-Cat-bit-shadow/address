import { createHash } from 'node:crypto';
import { pinyin } from 'pinyin-pro';
import type { SqliteDatabase } from '../../database/sqlite.mjs';
import type { AddressComponents, AddressEvidence, VerifiedAddress } from '../../../src/domain/types';
import type { AddressFilters } from './address-repository';

interface CommunityRow {
  id: string; canonical_name: string; province: string; city: string; district: string; township: string;
  provider_address: string; latitude: number; longitude: number; verification_level: 'L2' | 'L3';
  source_count: number; last_seen_at: string; providers: string;
}

export const CHINA_COMMUNITY_VALIDITY_DAYS = 180;
export const chinaFreshTimestampClause = (column: string): string =>
  `datetime(${column}) IS NOT NULL AND datetime(${column}) > datetime('now','-${CHINA_COMMUNITY_VALIDITY_DAYS} days')`;
export const chinaFreshSourceCountClause = (communityAlias = 'community', sourceAlias = 'fresh_source'): string => `(
  SELECT COUNT(DISTINCT ${sourceAlias}.provider) FROM cn_community_sources ${sourceAlias}
  WHERE ${sourceAlias}.community_id=${communityAlias}.id AND ${chinaFreshTimestampClause(`${sourceAlias}.last_seen_at`)}
)`;
export const chinaCommunityPublicationClause = (alias = 'community'): string => [
  `${alias}.active=1`,
  `${alias}.verification_level IN ('L2','L3')`,
  chinaFreshTimestampClause(`${alias}.last_seen_at`),
  `${chinaFreshSourceCountClause(alias)}>=2`
].join(' AND ');

const seedIndex = (seed: string, length: number): number => Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % length;
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
  const native: AddressComponents = {
    houseNumber: '', street: row.provider_address, buildingName: row.canonical_name,
    locality: row.city, postalLocality: row.city, district: row.district,
    ...(row.township ? { dependentLocality: row.township } : {}), admin1: row.province, postcode: ''
  };
  const english: AddressComponents = {
    ...native,
    street: romanize(row.provider_address), buildingName: romanize(row.canonical_name), locality: romanize(row.city),
    postalLocality: romanize(row.city), district: romanize(row.district),
    ...(row.township ? { dependentLocality: romanize(row.township) } : {}), admin1: romanize(row.province)
  };
  const nativeAddress = `${row.province}${row.city}${row.district}${row.township}${row.provider_address}${row.canonical_name}`;
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

export const countChinaCommunities = async (database?: SqliteDatabase): Promise<number> => {
  if (!database) return 0;
  try {
    return Number(await database.prepare(`SELECT COUNT(*) AS total FROM cn_communities_v2 community
      WHERE ${chinaCommunityPublicationClause('community')}`).first('total') || 0);
  }
  catch { return 0; }
};

export const pickChinaCommunityAddress = async (
  database: SqliteDatabase | undefined,
  filters: AddressFilters,
  seed: string,
  coordinates?: { latitude: number; longitude: number }
): Promise<VerifiedAddress | undefined> => {
  if (!database) return undefined;
  // A single provider POI is only a lead. Publish a community after at least
  // two independent map providers agree and the sync service assigns L2/L3.
  const clauses = [chinaCommunityPublicationClause('community')];
  const bindings: unknown[] = [];
  if (filters.region) { clauses.push('(community.province=? OR REPLACE(community.province,\'省\',\'\')=REPLACE(?,\'省\',\'\'))'); bindings.push(filters.region, filters.region); }
  if (filters.city) { clauses.push('(community.city=? OR REPLACE(community.city,\'市\',\'\')=REPLACE(?,\'市\',\'\'))'); bindings.push(filters.city, filters.city); }
  if (filters.q) { clauses.push('(community.canonical_name LIKE ? OR community.provider_address LIKE ?)'); bindings.push(`%${filters.q}%`, `%${filters.q}%`); }
  if (coordinates) {
    clauses.push('community.latitude BETWEEN ? AND ?', 'community.longitude BETWEEN ? AND ?');
    bindings.push(coordinates.latitude - 1, coordinates.latitude + 1, coordinates.longitude - 1, coordinates.longitude + 1);
  }
  let rows: CommunityRow[];
  try {
    rows = (await database.prepare(`SELECT community.*,GROUP_CONCAT(DISTINCT source.provider) AS providers FROM cn_communities_v2 community
      JOIN cn_community_sources source ON source.community_id=community.id AND ${chinaFreshTimestampClause('source.last_seen_at')}
      WHERE ${clauses.join(' AND ')} GROUP BY community.id ORDER BY community.source_count DESC,community.id LIMIT 500`)
      .bind(...bindings).all<CommunityRow>()).results;
  } catch { return undefined; }
  if (!rows.length) return undefined;
  const coordinateRows = coordinates
    ? rows.map((row) => ({ row, distanceKm: communityDistanceKm(coordinates, row) }))
      .filter((candidate) => candidate.distanceKm <= MAX_COMMUNITY_DISTANCE_KM)
      .sort((left, right) => left.distanceKm - right.distanceKm)
      .map(({ row }) => row)
    : rows;
  if (!coordinateRows.length) return undefined;
  const selected = coordinates ? coordinateRows[0] : coordinateRows[seedIndex(seed, coordinateRows.length)];
  return rowToAddress(selected);
};
