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

const mainlandProvinceNames = [
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省',
  '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省', '湖北省',
  '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省', '云南省',
  '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区'
];
const mainlandProvinceSql = mainlandProvinceNames.map((name) => `'${name}'`).join(',');

const loadCommunityProviders = async (database: Database, communityId: string): Promise<string> => {
  const rows = (await database.prepare(`SELECT DISTINCT provider FROM cn_community_sources
    WHERE community_id=? AND ${chinaFreshTimestampClause('last_seen_at')} ORDER BY provider`)
    .bind(communityId).all<{ provider: string }>()).results;
  return rows.map((row) => row.provider).join(',');
};

export const chinaFreshTimestampClause = (column: string): string =>
  `${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'`;
export const chinaFreshSourceCountClause = (communityAlias = 'community', sourceAlias = 'fresh_source'): string => `(
  SELECT COUNT(DISTINCT ${sourceAlias}.provider) FROM cn_community_sources ${sourceAlias}
  WHERE ${sourceAlias}.community_id=${communityAlias}.id AND ${chinaFreshTimestampClause(`${sourceAlias}.last_seen_at`)}
)`;
export const chinaCommunityPublicationClause = (alias = 'community'): string => [
  `${alias}.active=1`,
  `${alias}.province IN (${mainlandProvinceSql})`,
  chinaFreshTimestampClause(`${alias}.last_seen_at`),
  chinaDeliveryAddressClause(alias),
  `${alias}.provider_address ~ '^[^A-Za-z]+[0-9A-Za-z]+((弄|巷)[0-9A-Za-z]+)?([-之][0-9A-Za-z]+)*(号|號)(院|楼|栋|棟)?$'`,
  `${alias}.canonical_name ~ '^([^A-Za-z]|[A-Za-z](区|座|栋|棟|幢|单元|室|号|號|楼|组团|期))*$'`,
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
const seedKey = (seed: string): number => createHash('sha256').update(seed).digest().readUInt32BE(0) & 0x7fffffff;
const COMMUNITY_CANDIDATE_LIMIT = 16;
const communityRandomKey = (alias = 'community'): string => `(hashtextextended(${alias}.id, 0) & 2147483647)`;
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

const splitChinaDeliveryAddress = (value: string): { street: string; houseNumber: string } => {
  const match = value.match(/^(.+?)([0-9A-Za-z]+(?:(?:弄|巷)[0-9A-Za-z]+)?(?:[-之][0-9A-Za-z]+)*(?:号|號)(?:院|楼|栋|棟)?)$/u);
  if (!match) return { street: value, houseNumber: '' };
  return { street: match[1], houseNumber: match[2].replace(/號/gu, '号') };
};

const chinaEnglishHouseNumber = (value: string): string => value
  .replace(/[弄巷]/gu, '-')
  .replace(/(?:号|號)(?:院|楼|栋|棟)?$/u, '');

const rowToAddress = (row: CommunityRow): VerifiedAddress => {
  const providerAddress = normalizeChinaProviderAddress(row.provider_address, row);
  const delivery = splitChinaDeliveryAddress(providerAddress);
  const native: AddressComponents = {
    houseNumber: delivery.houseNumber, street: delivery.street, buildingName: row.canonical_name,
    locality: row.city, postalLocality: row.city, district: row.district,
    ...(row.township ? { dependentLocality: row.township } : {}), admin1: row.province, postcode: ''
  };
  const english: AddressComponents = {
    ...native,
    houseNumber: chinaEnglishHouseNumber(delivery.houseNumber), street: romanize(delivery.street),
    buildingName: romanize(row.canonical_name), locality: romanize(row.city),
    postalLocality: romanize(row.city), district: romanize(row.district),
    ...(row.township ? { dependentLocality: romanize(row.township) } : {}), admin1: romanize(row.province)
  };
  const nativeAddress = `${row.province}${row.city}${row.district}${row.township}${providerAddress}${row.canonical_name}`;
  const englishAddress = [english.buildingName, [english.houseNumber, english.street].filter(Boolean).join(' '), english.dependentLocality, english.district, english.locality, english.admin1, 'China']
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
    expiresAt: '9999-12-31T23:59:59.999Z',
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
    if (coordinates) {
      rows = (await database.prepare(`SELECT community.* FROM cn_communities_v2 community
        WHERE ${clauses.join(' AND ')} ORDER BY community.source_count DESC,community.id LIMIT 500`)
        .bind(...bindings).all<CommunityCandidateRow>()).results;
    } else {
      const pivot = seedKey(`${seed}:china-community`);
      const randomKey = communityRandomKey();
      const loadWindow = async (operator: '>=' | '<'): Promise<CommunityCandidateRow[]> =>
        (await database.prepare(`SELECT community.* FROM cn_communities_v2 community
          WHERE ${clauses.join(' AND ')} AND ${randomKey} ${operator} ?
          ORDER BY ${randomKey},community.id LIMIT ${COMMUNITY_CANDIDATE_LIMIT}`)
          .bind(...bindings, pivot).all<CommunityCandidateRow>()).results;
      const forward = await loadWindow('>=');
      if (forward.length >= COMMUNITY_CANDIDATE_LIMIT || typeof (database as { exec?: unknown }).exec !== 'function') rows = forward;
      else {
        const seen = new Set(forward.map(({ id }) => id));
        const wrapped = await loadWindow('<');
        rows = [...forward, ...wrapped.filter(({ id }) => !seen.has(id))].slice(0, COMMUNITY_CANDIDATE_LIMIT);
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
  const selected = coordinates ? coordinateRows[0] : coordinateRows[seedIndex(`${seed}:candidate`, coordinateRows.length)];
  try {
    const providers = await loadCommunityProviders(database, selected.id);
    return providers ? rowToAddress({ ...selected, providers }) : undefined;
  } catch (error) {
    if (process.env.NODE_ENV === 'test') throw error;
    return undefined;
  }
};
