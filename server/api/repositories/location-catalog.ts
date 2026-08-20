import { pinyin } from 'pinyin-pro';
import type { CountryCode, LocationOption } from '../../../src/domain/types';
import type { Database } from '../../database/database.mjs';
import { chinaCommunityPublicationClause } from './china-community';

export type CatalogField = 'region' | 'city' | 'district' | 'postcode';

export interface CatalogQuery {
  country: CountryCode;
  field: CatalogField;
  query?: string;
  region?: string;
  regionId?: string;
  cityId?: string;
  residential?: boolean;
  cursor?: string;
  limit?: number;
}

export interface CatalogPage {
  options: LocationOption[];
  total: number;
  availableTotal: number;
  nextCursor?: string;
  source: 'postgres';
}

interface RegionRow {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  native_name: string;
  zh_name: string;
}

interface CityRow {
  id: number;
  region_id: number | null;
  name: string;
  native_name: string;
  zh_name: string;
  region_name: string | null;
  region_native_name: string | null;
  region_zh_name: string | null;
  region_code: string | null;
}

interface PostcodeRow {
  id: number;
  city_id: number | null;
  code: string;
  locality_name: string;
  city_name: string | null;
  city_native_name: string | null;
  city_zh_name: string | null;
  region_id: number | null;
  region_name: string | null;
  region_native_name: string | null;
  region_zh_name: string | null;
  region_code: string | null;
}

interface AvailabilityRow { id: number; address_count: number }
interface ChinaProvinceAvailabilityRow { province: string; address_count: number }

const PAGE_SIZE = 100;
const normalizeLimit = (value = PAGE_SIZE, maximum = 200): number => {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : PAGE_SIZE;
  return Math.max(20, Math.min(maximum, parsed));
};
const normalizeOffset = (cursor?: string): number => Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
const searchPattern = (query?: string): string => `%${(query || '').trim().toLocaleLowerCase().replace(/[\\%_]/g, '\\$&')}%`;

const page = <T,>(rows: T[], total: number, offset: number): { rows: T[]; nextCursor?: string } => ({
  rows,
  nextCursor: offset + rows.length < total ? String(offset + rows.length) : undefined
});

const availabilityMap = (rows: AvailabilityRow[]): Map<number, number> => new Map(
  rows.map((row) => [Number(row.id), Number(row.address_count || 0)])
);

const regionAvailability = async (db: Database, country: CountryCode, rows: RegionRow[]): Promise<Map<number, number>> => {
  if (!rows.length) return new Map();
  const placeholders = rows.map(() => '?').join(',');
  if (country === 'CN') {
    const result = await db.prepare(`SELECT r.id,COUNT(community.id) AS address_count FROM catalog_regions r
      LEFT JOIN cn_communities_v2 community ON community.province IN (r.name,r.native_name,r.zh_name)
        AND ${chinaCommunityPublicationClause('community')}
      WHERE r.id IN (${placeholders}) GROUP BY r.id`).bind(...rows.map((row) => row.id)).all<AvailabilityRow>();
    return availabilityMap(result.results || []);
  }
  const result = await db.prepare(`SELECT selected.id,COALESCE(SUM(coverage.address_count),0) AS address_count
    FROM catalog_regions selected
    LEFT JOIN catalog_regions linked ON linked.country_code=selected.country_code
      AND (linked.id=selected.id OR linked.path LIKE selected.path||'/%')
    LEFT JOIN residential_coverage coverage ON coverage.country_code=selected.country_code AND coverage.region_id=linked.id
    WHERE selected.id IN (${placeholders}) GROUP BY selected.id`)
    .bind(...rows.map((row) => row.id)).all<AvailabilityRow>();
  return availabilityMap(result.results || []);
};

interface LegacyCityCoverageRow { city_name: string; address_count: number }

const legacyCityKey = (value: string): string => value.trim().replace(/ City/gu, '').toLocaleLowerCase('und');

const cityAvailability = async (db: Database, country: CountryCode, rows: CityRow[]): Promise<Map<number, number>> => {
  if (!rows.length) return new Map();
  const placeholders = rows.map(() => '?').join(',');
  const [direct, legacy] = await Promise.all([
    db.prepare(`SELECT city_id AS id,SUM(address_count) AS address_count FROM residential_coverage
      WHERE country_code=? AND city_id IN (${placeholders}) GROUP BY city_id`)
      .bind(country, ...rows.map((row) => row.id)).all<AvailabilityRow>(),
    db.prepare(`SELECT city_name,address_count FROM residential_coverage
      WHERE country_code=? AND city_id IS NULL AND city_name<>''`).bind(country).all<LegacyCityCoverageRow>()
  ]);
  const available = availabilityMap(direct.results || []);
  const idsByName = new Map<string, Set<number>>();
  for (const row of rows) {
    for (const name of [row.name, row.native_name]) {
      const key = legacyCityKey(name);
      if (!key) continue;
      const ids = idsByName.get(key) || new Set<number>();
      ids.add(Number(row.id));
      idsByName.set(key, ids);
    }
  }
  for (const coverage of legacy.results || []) {
    for (const id of idsByName.get(legacyCityKey(coverage.city_name)) || []) {
      available.set(id, (available.get(id) || 0) + Number(coverage.address_count || 0));
    }
  }
  return available;
};

// Publication gate for pool addresses, kept in sync with the /v1/generate
// residential path so displayed availability matches generatable records.
const residentialPoolClause = (alias = 'address'): string => `${alias}.active=1
  AND ${alias}.property_type IN ('residential','apartment') AND ${alias}.quality_score>=0.7
  AND EXISTS (SELECT 1 FROM address_pool_evidence evidence WHERE evidence.address_id=${alias}.id
    AND evidence.evidence_type='address_existence' AND evidence.is_current=1)
  AND EXISTS (SELECT 1 FROM address_pool_evidence evidence WHERE evidence.address_id=${alias}.id
    AND evidence.evidence_type='residential_use' AND evidence.is_current=1)`;

const postcodeAvailability = async (db: Database, country: CountryCode, rows: PostcodeRow[]): Promise<Map<number, number>> => {
  if (!rows.length) return new Map();
  const placeholders = rows.map(() => '?').join(',');
  // Use the persisted normalized key so PostgreSQL can use the country/postcode index.
  const result = await db.prepare(`SELECT postcode.id AS id, COUNT(address.id) AS address_count
    FROM catalog_postcodes postcode LEFT JOIN address_pool address
      ON address.country_code=? AND address.postcode_key=LOWER(REPLACE(postcode.code,' ',''))
      AND ${residentialPoolClause('address')}
    WHERE postcode.id IN (${placeholders}) GROUP BY postcode.id`)
    .bind(country, ...rows.map((row) => row.id)).all<AvailabilityRow>();
  return availabilityMap(result.results || []);
};

const regionLabel = (row: RegionRow, country: CountryCode): string => {
  if (country === 'CN') return row.zh_name;
  const abbreviation = row.code && ['US', 'CA', 'AU', 'BR', 'IN', 'MX', 'NG'].includes(country) ? `（${row.code}）` : '';
  const translated = row.zh_name && row.zh_name !== row.name ? row.zh_name : '';
  return `${row.name}${abbreviation}${translated ? ` ${translated}` : ''}`;
};

const cityLabel = (row: CityRow, country: CountryCode): string => {
  if (['CN', 'HK', 'TW'].includes(country)) return row.native_name || row.zh_name || row.name;
  const seen = new Set<string>();
  return [row.native_name, row.name, row.zh_name].filter((value) => {
    const key = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(' · ');
};

const queryRegions = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  if (input.country === 'CN') {
    const [regionResult, availabilityResult] = await Promise.all([
      db.prepare(`SELECT id,parent_id,code,name,native_name,zh_name FROM catalog_regions
        WHERE country_code=? AND parent_id IS NULL ORDER BY name`).bind('CN').all<RegionRow>(),
      db.prepare(`SELECT community.province,COUNT(community.id) AS address_count
        FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')}
        GROUP BY community.province`).all<ChinaProvinceAvailabilityRow>()
    ]);
    const availability = new Map((availabilityResult.results || [])
      .map((row) => [row.province.toLocaleLowerCase(), Number(row.address_count || 0)]));
    const query = (input.query || '').trim().toLocaleLowerCase();
    const unique = new Map<string, RegionRow>();
    for (const row of regionResult.results || []) {
      const key = row.name.toLocaleLowerCase();
      if (!unique.has(key)) unique.set(key, row);
    }
    const matching = [...unique.values()].filter((row) => !query
      || [row.name, row.native_name, row.zh_name, row.code].some((value) => value.toLocaleLowerCase().includes(query)));
    const rows = matching.filter((row) => !input.residential
      || [row.name, row.native_name, row.zh_name].some((value) => (availability.get(value.toLocaleLowerCase()) || 0) > 0));
    const current = page(rows.slice(offset, offset + limit), rows.length, offset);
    return {
      options: current.rows.map((row) => {
        const availableCount = Math.max(...[row.name, row.native_name, row.zh_name]
          .map((value) => availability.get(value.toLocaleLowerCase()) || 0));
        return {
          value: row.zh_name || row.native_name || row.name,
          label: regionLabel(row, input.country),
          availableCount,
          disabled: Boolean(input.residential) && availableCount === 0,
          id: String(row.id),
           parentId: row.parent_id == null ? undefined : String(row.parent_id),
           regionCode: row.code || undefined,
           native: row.native_name,
          en: row.name,
          zhCN: row.zh_name
        };
      }),
      total: rows.length,
      availableTotal: matching.filter((row) => [row.name, row.native_name, row.zh_name]
        .some((value) => (availability.get(value.toLocaleLowerCase()) || 0) > 0)).length,
      nextCursor: current.nextCursor,
      source: 'postgres'
    };
  }
  const query = (input.query || '').trim();
  const pattern = searchPattern(query);
  const search = query
    ? `AND (LOWER(r.name) LIKE ? ESCAPE '\\' OR LOWER(r.native_name) LIKE ? ESCAPE '\\' OR LOWER(r.zh_name) LIKE ? ESCAPE '\\' OR LOWER(r.code) LIKE ? ESCAPE '\\')`
    : '';
  const where = `r.country_code = ? AND r.parent_id IS NULL ${search}`;
  const bindings = query ? [input.country, pattern, pattern, pattern, pattern] : [input.country];
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM (
    SELECT 1 FROM catalog_regions r WHERE ${where} GROUP BY LOWER(r.name)
  ) grouped_regions`).bind(...bindings).first<{ total: number }>();
  const availableCount = await db.prepare(`SELECT COUNT(DISTINCT r.id) AS total
      FROM catalog_regions r
      JOIN catalog_regions linked ON linked.country_code=r.country_code
        AND (linked.id=r.id OR linked.path LIKE r.path||'/%')
      JOIN residential_coverage coverage ON coverage.country_code=r.country_code AND coverage.region_id=linked.id
      WHERE ${where}`).bind(...bindings).first<{ total: number }>();
  const result = await db.prepare(`SELECT MIN(r.id) AS id, NULL AS parent_id, MIN(r.code) AS code,
    MIN(r.name) AS name, MIN(r.native_name) AS native_name, MIN(r.zh_name) AS zh_name
    FROM catalog_regions r WHERE ${where} GROUP BY LOWER(r.name) ORDER BY MIN(r.name) LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all<RegionRow>();
  const total = Number(count?.total || 0);
  const current = page(result.results || [], total, offset);
  const available = await regionAvailability(db, input.country, current.rows);
  return {
    options: current.rows.map((row) => {
      const availableCount = available.get(Number(row.id)) || 0;
      return { value: row.name, label: regionLabel(row, input.country), availableCount, disabled: input.residential && availableCount === 0,
        id: String(row.id), parentId: row.parent_id == null ? undefined : String(row.parent_id), regionCode: row.code || undefined,
        native: row.native_name, en: row.name, zhCN: row.zh_name };
    }),
    total,
    availableTotal: Number(availableCount?.total || 0),
    nextCursor: current.nextCursor,
    source: 'postgres'
  };
};

const regionScope = (regionId?: string): { sql: string; bindings: number[] } => {
  const id = Number.parseInt(regionId || '', 10);
  if (!Number.isFinite(id)) return { sql: '', bindings: [] };
  return {
    sql: `AND c.region_id IN (SELECT child.id FROM catalog_regions selected JOIN catalog_regions child ON child.path LIKE selected.path || '%' WHERE selected.id = ?)`,
    bindings: [id]
  };
};

const queryCities = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  const query = (input.query || '').trim();
  const pattern = searchPattern(query);
  const scope = regionScope(input.regionId);
  const search = query
    ? `AND (LOWER(c.name) LIKE ? ESCAPE '\\' OR LOWER(c.native_name) LIKE ? ESCAPE '\\' OR LOWER(c.zh_name) LIKE ? ESCAPE '\\')`
    : '';
  const where = `c.country_code = ? ${scope.sql} ${search}`;
  const bindings = query
    ? [input.country, ...scope.bindings, pattern, pattern, pattern]
    : [input.country, ...scope.bindings];
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM (
    SELECT 1 FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
    WHERE ${where} GROUP BY LOWER(c.name), LOWER(COALESCE(r.name, ''))
  ) grouped_cities`).bind(...bindings).first<{ total: number }>();
  const availableCount = await db.prepare(`WITH legacy_names AS (
      SELECT LOWER(city_name) AS name FROM residential_coverage
        WHERE country_code=? AND city_id IS NULL AND city_name<>''
      UNION SELECT LOWER(city_name||' City') FROM residential_coverage
        WHERE country_code=? AND city_id IS NULL AND city_name<>''
      UNION SELECT LOWER(SUBSTRING(city_name, 1, LENGTH(city_name) - 5)) FROM residential_coverage
        WHERE country_code=? AND city_id IS NULL AND LOWER(city_name) LIKE '% city'
    ), available_ids AS (
      SELECT c.id FROM catalog_cities c JOIN residential_coverage coverage
        ON coverage.country_code=c.country_code AND coverage.city_id=c.id WHERE ${where}
      UNION
      SELECT c.id FROM catalog_cities c JOIN legacy_names legacy
        ON LOWER(c.name)=legacy.name OR LOWER(c.native_name)=legacy.name WHERE ${where}
    ) SELECT COUNT(*) AS total FROM available_ids`)
    .bind(input.country, input.country, input.country, ...bindings, ...bindings).first<{ total: number }>();
  const result = await db.prepare(`SELECT c.id, c.region_id, c.name, c.native_name, c.zh_name,
    c.region_name, c.region_native_name, c.region_zh_name, c.region_code FROM (
      SELECT MIN(c.id) AS id, MIN(c.region_id) AS region_id,
        MIN(c.name) AS name, MIN(c.native_name) AS native_name, MIN(c.zh_name) AS zh_name,
        MIN(r.name) AS region_name, MIN(r.native_name) AS region_native_name,
        MIN(r.zh_name) AS region_zh_name, MIN(r.code) AS region_code, MAX(COALESCE(c.population, 0)) AS population
      FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
      WHERE ${where} GROUP BY LOWER(c.name), LOWER(COALESCE(r.name, ''))
    ) c ORDER BY c.population DESC, c.name, c.id LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all<CityRow>();
  const total = Number(count?.total || 0);
  const current = page(result.results || [], total, offset);
  const available = await cityAvailability(db, input.country, current.rows);
  return {
    options: current.rows.map((row) => ({
      value: row.name,
      label: cityLabel(row, input.country),
      availableCount: available.get(Number(row.id)) || 0,
      disabled: input.residential && (available.get(Number(row.id)) || 0) === 0,
      id: String(row.id),
      parentId: row.region_id == null ? undefined : String(row.region_id),
      parentValue: row.region_name || undefined,
      parentLabel: row.region_name ? regionLabel({
        id: row.region_id || 0,
        parent_id: null,
        code: row.region_code || '',
        name: row.region_name,
        native_name: row.region_native_name || row.region_name,
        zh_name: row.region_zh_name || row.region_name
      }, input.country) : undefined,
      regionId: row.region_id == null ? undefined : String(row.region_id),
      regionValue: row.region_name || undefined,
      regionCode: row.region_code || undefined,
      native: row.native_name,
      en: row.name,
      zhCN: row.zh_name
    })),
    total,
    availableTotal: Number(availableCount?.total || 0),
    nextCursor: current.nextCursor,
    source: 'postgres'
  };
};

interface DistrictRow { district: string; address_count: number }

const emptyPage: CatalogPage = { options: [], total: 0, availableTotal: 0, source: 'postgres' };

// --- China community-backed city options -----------------------------------
// The dr5hn catalog models CN unreliably (districts listed as cities, "X" and
// "X Shi" duplicates, mistranslated zh names), so CN city options are served
// from the published communities themselves and only mapped back to catalog
// ids so the /v1/generate catalog gate keeps working.

interface ChinaCityGroupRow { province: string; city: string; address_count: number }
interface ChinaCatalogCityRow { id: number; region_id: number | null; name: string; native_name: string; zh_name: string; population: number | null }
interface ChinaRegionRow { id: number; code: string; name: string; native_name: string; zh_name: string }

export const CN_SYNTHETIC_CITY_PREFIX = 'cn-city-';
export const CN_SYNTHETIC_DISTRICT_PREFIX = 'cn-district-';
const cnEthnicPrefectureSuffix = /(?:[一-鿿]{1,8}族)*自治[州县縣旗]$/u;
const cnCitySuffix = /(?:地区|地區|林区|林區|新区|新區|盟|市)$/u;
const cnCityStem = (value: string): string => {
  const stemmed = (value || '').replace(cnEthnicPrefectureSuffix, '').replace(cnCitySuffix, '');
  return stemmed || (value || '');
};
const romanizeChinese = (value: string): string => pinyin(value, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
  .map((part) => part.trim()).filter(Boolean).join(' ').replace(/^\p{Ll}/u, (first) => first.toUpperCase());
const syntheticCityId = (city: string): string => `${CN_SYNTHETIC_CITY_PREFIX}${Buffer.from(city, 'utf8').toString('hex')}`;
export const decodeSyntheticCityId = (id: string | undefined): string | undefined => {
  if (!id?.startsWith(CN_SYNTHETIC_CITY_PREFIX)) return undefined;
  const hex = id.slice(CN_SYNTHETIC_CITY_PREFIX.length);
  if (!/^[0-9a-f]+$/u.test(hex) || hex.length % 2 !== 0) return undefined;
  return Buffer.from(hex, 'hex').toString('utf8');
};
const syntheticDistrictId = (district: string): string => `${CN_SYNTHETIC_DISTRICT_PREFIX}${Buffer.from(district, 'utf8').toString('hex')}`;
export const decodeSyntheticDistrictId = (id: string | undefined): string | undefined => {
  if (!id?.startsWith(CN_SYNTHETIC_DISTRICT_PREFIX)) return undefined;
  const hex = id.slice(CN_SYNTHETIC_DISTRICT_PREFIX.length);
  if (!/^[0-9a-f]+$/u.test(hex) || hex.length % 2 !== 0) return undefined;
  return Buffer.from(hex, 'hex').toString('utf8');
};
const searchableKey = (value: string): string => (value || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().replace(/[\s\-'･·]/g, '');

const chinaRegions = async (db: Database): Promise<ChinaRegionRow[]> =>
  (await db.prepare(`SELECT id, code, name, native_name, zh_name FROM catalog_regions WHERE country_code = ? AND parent_id IS NULL`)
    .bind('CN').all<ChinaRegionRow>()).results || [];

const stripProvinceSuffix = (value: string): string => (value || '').replace(/省$/u, '');

const matchChinaRegion = (regions: ChinaRegionRow[], regionId?: string, region?: string): ChinaRegionRow | undefined => {
  const id = Number.parseInt(regionId || '', 10);
  if (Number.isFinite(id)) return regions.find((row) => Number(row.id) === id);
  const needle = (region || '').trim().toLocaleLowerCase();
  if (!needle) return undefined;
  const stripped = stripProvinceSuffix(needle);
  return regions.find((row) => [row.name, row.native_name, row.zh_name].some((name) => {
    const lowered = (name || '').toLocaleLowerCase();
    return lowered === needle || stripProvinceSuffix(lowered) === stripped;
  }));
};

const chinaCatalogCandidates = async (db: Database, cities: string[]): Promise<Map<string, ChinaCatalogCityRow[]>> => {
  const byStem = new Map<string, ChinaCatalogCityRow[]>();
  const variants = [...new Set(cities.flatMap((city) => {
    const stem = cnCityStem(city);
    return [city, stem, `${stem}市`, `${stem}地区`, `${stem}盟`];
  }))].filter(Boolean);
  const seen = new Set<number>();
  for (let index = 0; index < variants.length; index += 300) {
    const chunk = variants.slice(index, index + 300);
    const placeholders = chunk.map(() => '?').join(',');
    const found = (await db.prepare(`SELECT c.id, c.region_id, c.name, c.native_name, c.zh_name, c.population
      FROM catalog_cities c WHERE c.country_code = ?
      AND (c.name IN (${placeholders}) OR c.native_name IN (${placeholders}) OR c.zh_name IN (${placeholders}))`)
      .bind('CN', ...chunk, ...chunk, ...chunk).all<ChinaCatalogCityRow>()).results || [];
    for (const candidate of found) {
      if (seen.has(Number(candidate.id))) continue;
      seen.add(Number(candidate.id));
      for (const stem of new Set([cnCityStem(candidate.native_name), cnCityStem(candidate.zh_name)].filter(Boolean))) {
        byStem.set(stem, [...(byStem.get(stem) || []), candidate]);
      }
    }
  }
  return byStem;
};

const pickChinaCatalogCity = (
  candidatesByStem: Map<string, ChinaCatalogCityRow[]>,
  city: string,
  province: ChinaRegionRow | undefined
): ChinaCatalogCityRow | undefined => {
  const candidates = candidatesByStem.get(cnCityStem(city)) || [];
  if (!candidates.length) return undefined;
  const score = (candidate: ChinaCatalogCityRow): number =>
    (candidate.native_name === city || candidate.zh_name === city ? 4 : 0)
    + (province && Number(candidate.region_id) === Number(province.id) ? 2 : 0);
  return [...candidates].sort((left, right) => score(right) - score(left)
    || Number(right.population || 0) - Number(left.population || 0)
    || Number(left.id) - Number(right.id))[0];
};

const chinaMunicipalityProxy = async (
  db: Database,
  province: ChinaRegionRow | undefined,
  row: ChinaCityGroupRow
): Promise<ChinaCatalogCityRow | undefined> => {
  if (!province || cnCityStem(row.city) !== cnCityStem(row.province)) return undefined;
  return await db.prepare(`SELECT c.id, c.region_id, c.name, c.native_name, c.zh_name, c.population
    FROM catalog_cities c WHERE c.country_code = ? AND c.region_id = ?
    ORDER BY COALESCE(c.population, 0) DESC LIMIT 1`)
    .bind('CN', province.id).first<ChinaCatalogCityRow>() || undefined;
};

const queryChinaCities = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  const regions = await chinaRegions(db);
  const scoped = Boolean((input.regionId || '').trim() || (input.region || '').trim());
  const regionRow = matchChinaRegion(regions, input.regionId, input.region);
  if (scoped && !regionRow) return emptyPage;
  const clauses = [chinaCommunityPublicationClause('community'), `community.city <> ''`];
  const bindings: unknown[] = [];
  if (regionRow) {
    clauses.push(`(community.province IN (?,?,?) OR REPLACE(community.province,'省','') IN (?,?,?))`);
    bindings.push(regionRow.name, regionRow.native_name, regionRow.zh_name,
      stripProvinceSuffix(regionRow.name), stripProvinceSuffix(regionRow.native_name), stripProvinceSuffix(regionRow.zh_name));
  }
  const grouped = (await db.prepare(`SELECT community.province AS province, community.city AS city, COUNT(community.id) AS address_count
    FROM cn_communities_v2 community WHERE ${clauses.join(' AND ')}
    GROUP BY community.province, community.city`).bind(...bindings).all<ChinaCityGroupRow>()).results || [];
  if (!grouped.length) return emptyPage;

  const candidatesByStem = await chinaCatalogCandidates(db, grouped.map((row) => row.city));
  const regionByName = new Map<string, ChinaRegionRow>();
  for (const region of regions) {
    for (const name of [region.name, region.native_name, region.zh_name]) {
      if (name) regionByName.set(name.toLocaleLowerCase(), region);
    }
  }

  const entries = grouped.map((row) => {
    const province = regionByName.get(row.province.toLocaleLowerCase());
    const catalogCity = pickChinaCatalogCity(candidatesByStem, row.city, province);
    return { row, province, catalogCity, en: catalogCity?.name || romanizeChinese(row.city) };
  });
  const needle = searchableKey(input.query || '');
  const filtered = entries
    .filter((entry) => !needle || [entry.row.city, cnCityStem(entry.row.city), entry.en].some((value) => searchableKey(value).includes(needle)))
    .sort((left, right) => right.row.address_count - left.row.address_count
      || left.row.city.localeCompare(right.row.city, 'zh-CN'));
  const total = filtered.length;
  const slice = filtered.slice(offset, offset + limit);

  const options: LocationOption[] = [];
  for (const entry of slice) {
    const catalogCity = entry.catalogCity || await chinaMunicipalityProxy(db, entry.province, entry.row);
    const availableCount = Number(entry.row.address_count || 0);
    options.push({
      value: entry.row.city,
      label: entry.row.city,
      availableCount,
      disabled: Boolean(input.residential) && availableCount === 0,
      id: catalogCity ? String(catalogCity.id) : syntheticCityId(entry.row.city),
      parentId: entry.province ? String(entry.province.id) : undefined,
      parentValue: entry.province?.zh_name || entry.row.province,
      parentLabel: entry.province?.zh_name || entry.row.province,
      regionId: entry.province ? String(entry.province.id) : undefined,
      regionValue: entry.province?.zh_name || entry.row.province,
      regionCode: entry.province?.code || undefined,
      native: entry.row.city,
      en: entry.en,
      zhCN: entry.row.city
    });
  }
  return {
    options,
    total,
    availableTotal: total,
    nextCursor: offset + options.length < total ? String(offset + options.length) : undefined,
    source: 'postgres'
  };
};

// China is the only country with a served district level; its published
// communities are the authoritative catalog, so every option has coverage
// and an uncovered district can never be selected (exact-or-empty rule).
const queryDistricts = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  if (input.country !== 'CN') return emptyPage;
  const clauses = [chinaCommunityPublicationClause('community'), `community.district <> ''`];
  const bindings: unknown[] = [];
  const regionId = Number.parseInt(input.regionId || '', 10);
  if (Number.isFinite(regionId)) {
    clauses.push(`community.province IN (SELECT name FROM catalog_regions WHERE id = ?
      UNION SELECT native_name FROM catalog_regions WHERE id = ?
      UNION SELECT zh_name FROM catalog_regions WHERE id = ?)`);
    bindings.push(regionId, regionId, regionId);
  } else if (input.region?.trim()) {
    clauses.push(`(community.province = ? OR REPLACE(community.province,'省','') = REPLACE(?,'省',''))`);
    bindings.push(input.region.trim(), input.region.trim());
  }
  const syntheticCity = decodeSyntheticCityId(input.cityId);
  const cityId = Number.parseInt(input.cityId || '', 10);
  if (syntheticCity) {
    clauses.push(`(community.city = ? OR REPLACE(community.city,'市','') = REPLACE(?,'市',''))`);
    bindings.push(syntheticCity, syntheticCity);
  } else if (Number.isFinite(cityId)) {
    // Suffix tolerance: the catalog stores 北京/唐山 while communities store
    // 北京市/唐山市. Municipality proxies (Shanghai has no city-proper catalog
    // row) resolve through their parent region instead.
    clauses.push(`(community.city IN (SELECT name FROM catalog_cities WHERE id = ?
        UNION SELECT native_name FROM catalog_cities WHERE id = ?
        UNION SELECT zh_name FROM catalog_cities WHERE id = ?)
      OR REPLACE(community.city,'市','') IN (SELECT REPLACE(name,'市','') FROM catalog_cities WHERE id = ?
        UNION SELECT REPLACE(native_name,'市','') FROM catalog_cities WHERE id = ?
        UNION SELECT REPLACE(zh_name,'市','') FROM catalog_cities WHERE id = ?)
      OR (community.city = community.province AND community.province IN (
        SELECT region.name FROM catalog_regions region JOIN catalog_cities city_ref ON city_ref.region_id = region.id WHERE city_ref.id = ?
        UNION SELECT region.native_name FROM catalog_regions region JOIN catalog_cities city_ref ON city_ref.region_id = region.id WHERE city_ref.id = ?
        UNION SELECT region.zh_name FROM catalog_regions region JOIN catalog_cities city_ref ON city_ref.region_id = region.id WHERE city_ref.id = ?)))`);
    bindings.push(cityId, cityId, cityId, cityId, cityId, cityId, cityId, cityId, cityId);
  }
  clauses.push(`LOWER(community.district) LIKE ? ESCAPE '\\'`);
  bindings.push(searchPattern(input.query));
  const where = clauses.join(' AND ');
  const count = await db.prepare(`SELECT COUNT(DISTINCT community.district) AS total
    FROM cn_communities_v2 community WHERE ${where}`).bind(...bindings).first<{ total: number }>();
  const result = await db.prepare(`SELECT community.district AS district, COUNT(community.id) AS address_count
    FROM cn_communities_v2 community WHERE ${where}
    GROUP BY community.district ORDER BY community.district LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all<DistrictRow>();
  const total = Number(count?.total || 0);
  const current = page(result.results || [], total, offset);
  return {
    options: current.rows.map((row) => {
      const availableCount = Number(row.address_count || 0);
      return {
        id: syntheticDistrictId(row.district), value: row.district, label: row.district, availableCount,
        disabled: input.residential && availableCount === 0,
        native: row.district, en: row.district, zhCN: row.district
      };
    }),
    total,
    availableTotal: total,
    nextCursor: current.nextCursor,
    source: 'postgres'
  };
};

const queryPostcodes = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  const pattern = searchPattern(input.query);
  const cityId = Number.parseInt(input.cityId || '', 10);
  const regionId = Number.parseInt(input.regionId || '', 10);
  const parentSql = Number.isFinite(cityId)
    ? `AND (p.city_id = ? OR LOWER(p.locality_name) IN (
        SELECT LOWER(name) FROM catalog_cities WHERE id = ?
        UNION SELECT LOWER(native_name) FROM catalog_cities WHERE id = ?
      ))`
    : Number.isFinite(regionId)
      ? `AND COALESCE(p.region_id, c.region_id) IN (SELECT child.id FROM catalog_regions selected JOIN catalog_regions child ON child.path LIKE selected.path || '%' WHERE selected.id = ?)`
      : '';
  const parentBindings = Number.isFinite(cityId) ? [cityId, cityId, cityId] : Number.isFinite(regionId) ? [regionId] : [];
  const where = `p.country_code = ? ${parentSql} AND (LOWER(p.code) LIKE ? ESCAPE '\\' OR LOWER(p.locality_name) LIKE ? ESCAPE '\\')`;
  const bindings = [input.country, ...parentBindings, pattern, pattern];
  const count = await db.prepare(`SELECT COUNT(DISTINCT p.code) AS total FROM catalog_postcodes p LEFT JOIN catalog_cities c ON c.id = p.city_id WHERE ${where}`).bind(...bindings).first<{ total: number }>();
  const availableCount = await db.prepare(`SELECT COUNT(DISTINCT p.code) AS total FROM catalog_postcodes p
    LEFT JOIN catalog_cities c ON c.id=p.city_id WHERE ${where} AND LOWER(REPLACE(p.code,' ','')) IN (
      SELECT address.postcode_key FROM address_pool address
      WHERE address.country_code=? AND ${residentialPoolClause('address')}
    )`).bind(...bindings, input.country).first<{ total: number }>();
  const result = await db.prepare(`SELECT MIN(p.id) AS id, MAX(p.city_id) AS city_id, p.code,
    MAX(p.locality_name) AS locality_name, MAX(c.name) AS city_name, MAX(c.native_name) AS city_native_name,
    MAX(c.zh_name) AS city_zh_name, MAX(COALESCE(p.region_id, c.region_id)) AS region_id,
    MAX(r.name) AS region_name, MAX(r.native_name) AS region_native_name, MAX(r.zh_name) AS region_zh_name,
    MAX(r.code) AS region_code
    FROM catalog_postcodes p
    LEFT JOIN catalog_cities c ON c.id = p.city_id
    LEFT JOIN catalog_regions r ON r.id = COALESCE(p.region_id, c.region_id)
    WHERE ${where} GROUP BY p.code ORDER BY p.code LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all<PostcodeRow>();
  const total = Number(count?.total || 0);
  const current = page(result.results || [], total, offset);
  const available = await postcodeAvailability(db, input.country, current.rows);
  return {
    options: current.rows.map((row) => ({
      value: row.code,
      label: [row.code, row.locality_name, row.region_name].filter(Boolean).join(' · '),
      availableCount: available.get(Number(row.id)) || 0,
      disabled: input.residential && (available.get(Number(row.id)) || 0) === 0,
      id: String(row.id),
      parentId: row.city_id == null ? undefined : String(row.city_id),
      parentValue: row.city_name || row.locality_name || undefined,
      parentLabel: row.city_name || row.locality_name || undefined,
      regionId: row.region_id == null ? undefined : String(row.region_id),
      regionValue: row.region_name || undefined,
      regionLabel: row.region_name ? regionLabel({
        id: row.region_id || 0,
        parent_id: null,
        code: row.region_code || '',
        name: row.region_name,
        native_name: row.region_native_name || row.region_name,
        zh_name: row.region_zh_name || row.region_name
      }, input.country) : undefined,
      regionCode: row.region_code || undefined,
      native: [row.code, row.city_native_name || row.locality_name].filter(Boolean).join(' · '),
      en: [row.code, row.city_name || row.locality_name].filter(Boolean).join(' · '),
      zhCN: [row.code, row.city_zh_name || row.locality_name].filter(Boolean).join(' · ')
    })),
    total,
    availableTotal: Number(availableCount?.total || 0),
    nextCursor: current.nextCursor,
    source: 'postgres'
  };
};

const locationCatalogCache = new WeakMap<Database, Map<string, { expiresAt: number; promise: Promise<CatalogPage> }>>();
const catalogCacheKey = (input: CatalogQuery): string => JSON.stringify([
  input.country, input.field, input.query || '', input.region || '', input.regionId || '', input.cityId || '',
  Boolean(input.residential), input.cursor || '', input.limit ?? null
]);

export const invalidateLocationCatalogCache = (db: Database): void => {
  locationCatalogCache.delete(db);
};

export const queryLocationCatalog = async (db: Database, input: CatalogQuery): Promise<CatalogPage> => {
  const key = catalogCacheKey(input);
  let cache = locationCatalogCache.get(db);
  if (!cache) {
    cache = new Map();
    locationCatalogCache.set(db, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const limit = normalizeLimit(input.limit, 200);
  const offset = normalizeOffset(input.cursor);
  const promise = input.field === 'region' ? queryRegions(db, input, limit, offset)
    : input.field === 'city' ? (input.country === 'CN' ? queryChinaCities(db, input, limit, offset) : queryCities(db, input, limit, offset))
      : input.field === 'district' ? queryDistricts(db, input, limit, offset)
        : queryPostcodes(db, input, limit, offset);
  cache.set(key, { expiresAt: Number.POSITIVE_INFINITY, promise });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [candidate, value] of cache) if (value.expiresAt <= now) cache.delete(candidate);
    while (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  void promise.then(() => {
    const current = cache?.get(key);
    if (current?.promise === promise) current.expiresAt = Date.now() + 30_000;
  }, () => {
    if (cache?.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
};

export const recordResidentialCoverage = async (
  db: Database | undefined,
  country: CountryCode,
  region: string | undefined,
  city: string | undefined,
  coordinates?: { latitude: number; longitude: number }
): Promise<void> => {
  if (!db) return;
  const now = new Date().toISOString();
  const cityName = city || '';
  let catalogLocation = await db.prepare(`SELECT c.id AS city_id, c.region_id
    FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
    WHERE c.country_code = ? AND (
      LOWER(c.name) = LOWER(?) OR LOWER(c.native_name) = LOWER(?) OR LOWER(c.zh_name) = LOWER(?)
      OR LOWER(REPLACE(c.name, ' City', '')) = LOWER(REPLACE(?, ' City', ''))
      OR LOWER(REPLACE(c.name, 'City of ', '')) = LOWER(REPLACE(?, 'City of ', ''))
    )
    ORDER BY CASE WHEN ? IN (r.name, r.native_name, r.zh_name) THEN 0 ELSE 1 END, COALESCE(c.population, 0) DESC LIMIT 1`)
    .bind(country, cityName, cityName, cityName, cityName, cityName, region || '').first<{ city_id: number; region_id: number | null }>();
  if (!catalogLocation && coordinates) {
    catalogLocation = await db.prepare(`SELECT id AS city_id, region_id FROM catalog_cities
      WHERE country_code = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY ((latitude - ?) * (latitude - ?)) + ((longitude - ?) * (longitude - ?)) LIMIT 1`)
      .bind(country, coordinates.latitude, coordinates.latitude, coordinates.longitude, coordinates.longitude)
      .first<{ city_id: number; region_id: number | null }>();
  }
  await db.prepare(`INSERT INTO residential_coverage(country_code, region_name, city_name, address_count, last_verified_at, region_id, city_id)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(country_code, region_name, city_name) DO UPDATE SET
      address_count = address_count + 1,
      last_verified_at = excluded.last_verified_at,
      region_id = COALESCE(excluded.region_id, residential_coverage.region_id),
      city_id = COALESCE(excluded.city_id, residential_coverage.city_id)`)
    .bind(country, region || '', cityName, now, catalogLocation?.region_id || null, catalogLocation?.city_id || null).run();
  invalidateLocationCatalogCache(db);
};
