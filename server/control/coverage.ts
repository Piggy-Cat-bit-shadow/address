import type { Database } from '../database/database.mjs';
import { countries } from '../../src/domain/countries';
import { completenessClause } from '../api/repositories/address-pool-v2';
import { chinaCommunityPublicationClause } from '../api/repositories/china-community';

const nowIso = (): string => new Date().toISOString();
const levelLabels: Record<string, string[]> = {
  CN: ['国家', '省级', '地级市', '区县', '街道乡镇'],
  US: ['国家', '州', '城市', '区县'],
  CA: ['国家', '省', '城市', '区域'],
  JP: ['国家', '都道府县', '市区町村', '地区'],
  GB: ['国家', '构成国/地区', '城市', '区域']
};

export interface CoverageNode {
  key: string;
  countryCode: string;
  level: number;
  levelLabel: string;
  regionCode: string;
  regionName: string;
  ordinaryCount: number;
  residentialCount: number;
  totalCount: number;
  childCount: number;
  updatedAt: string;
  regionNameEn?: string;
  regionNameZh?: string;
  levelLabelEn?: string;
  levelLabelZh?: string;
  coverageLevels?: CoverageLevelSummary[];
}

export interface CoverageLevelSummary {
  key: 'region' | 'subregion' | 'city' | 'district';
  labelEn: string;
  labelZh: string;
  covered: number;
  qualified: number;
  total: number;
}

const hierarchyLabels: Record<string, Array<[string, string]>> = {
  AU: [['State / territory', '州/领地'], ['Locality', '地方']], BR: [['State', '州'], ['Municipality', '市镇']],
  CA: [['Province / territory', '省/地区'], ['City', '城市']], CN: [['Province-level', '省级'], ['Prefecture-level', '地级'], ['District / county', '区县']],
  DE: [['Federal state', '联邦州'], ['District', '县/非县辖市'], ['Municipality', '市镇']], ES: [['Autonomous community', '自治区'], ['Province', '省'], ['Municipality', '市镇']],
  FR: [['Region', '大区'], ['Department', '省'], ['Commune', '市镇']], GB: [['Constituent country', '构成国'], ['Administrative area', '行政区'], ['City', '城市']],
  HK: [['Region', '区域'], ['District', '区']], IN: [['State / territory', '邦/中央直辖区'], ['District / city', '县/城市']],
  IT: [['Region', '大区'], ['Province', '省'], ['Municipality', '市镇']], JP: [['Prefecture', '都道府县'], ['Municipality', '市区町村']],
  KR: [['Province / metropolitan city', '道/广域市'], ['City / district', '市/区']], MX: [['State', '州'], ['Municipality', '市镇']],
  MY: [['State / territory', '州/联邦直辖区'], ['District / city', '县/城市']], NG: [['State', '州'], ['Local government area', '地方政府区']],
  NL: [['Province', '省'], ['Municipality', '市镇']], PH: [['Region', '大区'], ['Province', '省'], ['City / municipality', '城市/市镇']],
  RU: [['Federal subject', '联邦主体'], ['City / district', '城市/区']], SA: [['Region', '行政区'], ['City', '城市']],
  SG: [['Planning region', '规划区域'], ['Planning area', '规划区']], TH: [['Province', '府'], ['District', '县']],
  TR: [['Province', '省'], ['District', '县']], TW: [['County / city', '县市'], ['District / township', '区/乡镇']],
  US: [['State', '州'], ['City', '城市']], VN: [['Province / municipality', '省/直辖市'], ['District', '区县']],
  ZA: [['Province', '省'], ['Municipality', '市镇']]
};

export const coverageLevelLabel = (countryCode: string, level: number): string =>
  levelLabels[countryCode]?.[level] || ['国家', '一级行政区', '城市', '区县', '下级区域'][level] || '区域';

export const refreshAddressCoverage = async (database: Database): Promise<void> => {
  const now = nowIso();
  const allowedDatasetIds = `SELECT dataset.id FROM address_datasets dataset
    JOIN address_sources source ON source.id=dataset.source_id AND source.redistribution_allowed=1
    WHERE dataset.status='active' AND dataset.redistribution_allowed=1`;
  const evidencedAddressIds = (type: 'address_existence' | 'residential_use'): string => `SELECT evidence.address_id
    FROM address_pool_evidence evidence WHERE evidence.evidence_type='${type}' AND evidence.is_current=1
    AND evidence.dataset_id IN (${allowedDatasetIds})`;
  const statements = [
    database.prepare('DROP TABLE IF EXISTS strict_pool_rows'),
    database.prepare(`CREATE TEMP TABLE strict_pool_rows(
      id TEXT,country_code TEXT,admin1 TEXT,locality TEXT,district TEXT)`),
    database.prepare(`INSERT INTO strict_pool_rows(id,country_code,admin1,locality,district)
      SELECT address_pool.id,address_pool.country_code,address_pool.admin1,address_pool.locality,address_pool.district
      FROM address_pool
      WHERE address_pool.active=1 AND address_pool.property_type IN ('residential','apartment')
        AND address_pool.quality_score>=0.7 AND ${completenessClause('address_pool.')}
        AND address_pool.id IN (${evidencedAddressIds('address_existence')})
        AND address_pool.id IN (${evidencedAddressIds('residential_use')})`),
    database.prepare('DELETE FROM admin_coverage_stats')
  ];
  for (const country of countries) {
    statements.push(database.prepare(`INSERT INTO admin_coverage_stats(
      node_key,parent_key,country_code,level,region_code,region_name,updated_at) VALUES (?, '', ?, 0, ?, ?, ?)`)
      .bind(country.code, country.code, country.code, country.name['zh-CN'], now));
  }
  statements.push(
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      ordinary_count,residential_count,total_count,updated_at)
      SELECT country_code||':a1:'||encode(convert_to(admin1,'UTF8'),'hex'),country_code,country_code,1,admin1,
        0,COUNT(*),COUNT(*),?
      FROM strict_pool_rows WHERE country_code<>'CN' AND admin1<>''
      GROUP BY country_code,admin1`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      ordinary_count,residential_count,total_count,updated_at)
      SELECT country_code||':loc:'||encode(convert_to(admin1,'UTF8'),'hex')||':'||encode(convert_to(locality,'UTF8'),'hex'),country_code||':a1:'||encode(convert_to(admin1,'UTF8'),'hex'),country_code,2,locality,
        0,COUNT(*),COUNT(*),?
      FROM strict_pool_rows WHERE country_code<>'CN' AND admin1<>'' AND locality<>''
      GROUP BY country_code,admin1,locality`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      ordinary_count,residential_count,total_count,updated_at)
      SELECT country_code||':dist:'||encode(convert_to(admin1,'UTF8'),'hex')||':'||encode(convert_to(locality,'UTF8'),'hex')||':'||encode(convert_to(district,'UTF8'),'hex'),
        country_code||':loc:'||encode(convert_to(admin1,'UTF8'),'hex')||':'||encode(convert_to(locality,'UTF8'),'hex'),country_code,3,district,
        0,COUNT(*),COUNT(*),?
      FROM strict_pool_rows WHERE country_code<>'CN' AND admin1<>'' AND locality<>'' AND district<>''
      GROUP BY country_code,admin1,locality,district`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_code,region_name,updated_at)
      SELECT 'CN:a1:'||encode(convert_to(name,'UTF8'),'hex'),'CN','CN',1,adcode,name,? FROM cn_admin_areas WHERE level='province'
      ON CONFLICT(node_key) DO UPDATE SET region_code=excluded.region_code`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_code,region_name,updated_at)
      SELECT 'CN:loc:'||encode(convert_to(parent.name,'UTF8'),'hex')||':'||encode(convert_to(area.name,'UTF8'),'hex'),'CN:a1:'||encode(convert_to(parent.name,'UTF8'),'hex'),'CN',2,area.adcode,area.name,?
      FROM cn_admin_areas area JOIN cn_admin_areas parent ON parent.adcode=area.parent_adcode WHERE area.level='city'
      ON CONFLICT(node_key) DO UPDATE SET region_code=excluded.region_code`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_code,region_name,updated_at)
      SELECT 'CN:dist:'||encode(convert_to(province.name,'UTF8'),'hex')||':'||encode(convert_to(city.name,'UTF8'),'hex')||':'||encode(convert_to(area.name,'UTF8'),'hex'),
        'CN:loc:'||encode(convert_to(province.name,'UTF8'),'hex')||':'||encode(convert_to(city.name,'UTF8'),'hex'),'CN',3,area.adcode,area.name,?
      FROM cn_admin_areas area JOIN cn_admin_areas city ON city.adcode=area.parent_adcode
      JOIN cn_admin_areas province ON province.adcode=city.parent_adcode WHERE area.level='district'
      ON CONFLICT(node_key) DO UPDATE SET region_code=excluded.region_code`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      residential_count,total_count,updated_at)
      SELECT 'CN:a1:'||encode(convert_to(province,'UTF8'),'hex'),'CN','CN',1,province,COUNT(*),COUNT(*),?
      FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')} GROUP BY province
      ON CONFLICT(node_key) DO UPDATE SET residential_count=excluded.residential_count,
        total_count=admin_coverage_stats.ordinary_count+excluded.residential_count,updated_at=excluded.updated_at`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      residential_count,total_count,updated_at)
      SELECT 'CN:loc:'||encode(convert_to(province,'UTF8'),'hex')||':'||encode(convert_to(city,'UTF8'),'hex'),'CN:a1:'||encode(convert_to(province,'UTF8'),'hex'),'CN',2,city,COUNT(*),COUNT(*),?
      FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')} GROUP BY province,city
      ON CONFLICT(node_key) DO UPDATE SET residential_count=excluded.residential_count,
        total_count=admin_coverage_stats.ordinary_count+excluded.residential_count,updated_at=excluded.updated_at`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      residential_count,total_count,updated_at)
      SELECT 'CN:dist:'||encode(convert_to(province,'UTF8'),'hex')||':'||encode(convert_to(city,'UTF8'),'hex')||':'||encode(convert_to(district,'UTF8'),'hex'),
        'CN:loc:'||encode(convert_to(province,'UTF8'),'hex')||':'||encode(convert_to(city,'UTF8'),'hex'),'CN',3,district,COUNT(*),COUNT(*),?
      FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')} AND district<>'' GROUP BY province,city,district
      ON CONFLICT(node_key) DO UPDATE SET residential_count=excluded.residential_count,
        total_count=admin_coverage_stats.ordinary_count+excluded.residential_count,updated_at=excluded.updated_at`).bind(now),
    database.prepare('UPDATE admin_coverage_stats SET ordinary_count=0,residential_count=0 WHERE level=0'),
    database.prepare(`UPDATE admin_coverage_stats SET residential_count=(
      SELECT COUNT(*) FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')})
      WHERE level=0 AND country_code='CN'`),
    database.prepare(`UPDATE admin_coverage_stats SET residential_count=country_counts.total
      FROM (SELECT country_code,COUNT(*) AS total FROM strict_pool_rows GROUP BY country_code) country_counts
      WHERE admin_coverage_stats.level=0 AND admin_coverage_stats.country_code=country_counts.country_code
        AND country_counts.country_code<>'CN'`),
    database.prepare('UPDATE admin_coverage_stats SET total_count=ordinary_count+residential_count WHERE level=0'),
    database.prepare('UPDATE admin_coverage_stats SET child_count=0'),
    database.prepare(`UPDATE admin_coverage_stats SET child_count=child_counts.total
      FROM (SELECT parent_key,COUNT(*) AS total FROM admin_coverage_stats GROUP BY parent_key) child_counts
      WHERE admin_coverage_stats.node_key=child_counts.parent_key`),
    database.prepare('DROP TABLE IF EXISTS strict_pool_rows')
  );
  await database.batch(statements);
};

interface CatalogRegionRow {
  id: number;
  parent_id: number | null;
  country_code: string;
  code: string;
  name: string;
  native_name: string;
  zh_name: string;
  path: string;
}

const catalogCoverageSummaries = async (database: Database): Promise<Map<string, CoverageLevelSummary[]>> => {
  const [regionRows, cityTotals, coverageRows] = await Promise.all([
    database.prepare(`SELECT id,parent_id,country_code,code,name,native_name,zh_name,path
      FROM catalog_regions`).all<CatalogRegionRow>(),
    database.prepare('SELECT country_code,COUNT(*) AS total FROM catalog_cities GROUP BY country_code')
      .all<{ country_code: string; total: number }>(),
    database.prepare(`SELECT country_code,region_id,city_id,SUM(address_count) AS address_count
      FROM residential_coverage WHERE region_id IS NOT NULL GROUP BY country_code,region_id,city_id`)
      .all<{ country_code: string; region_id: number; city_id: number | null; address_count: number }>()
  ]);
  const regions = regionRows.results || [];
  const byId = new Map(regions.map((region) => [Number(region.id), region]));
  const totals = new Map<string, { root: number; child: number; city: number }>();
  const regionCounts = new Map<number, number>();
  const cityCounts = new Map<number, number>();
  const cityCountries = new Map<number, string>();
  for (const region of regions) {
    const current = totals.get(region.country_code) || { root: 0, child: 0, city: 0 };
    if (region.parent_id == null) current.root += 1;
    else current.child += 1;
    totals.set(region.country_code, current);
  }
  for (const row of cityTotals.results || []) {
    const current = totals.get(row.country_code) || { root: 0, child: 0, city: 0 };
    current.city = Number(row.total || 0);
    totals.set(row.country_code, current);
  }
  for (const row of coverageRows.results || []) {
    const count = Number(row.address_count || 0);
    if (row.city_id != null) {
      const cityId = Number(row.city_id);
      cityCounts.set(cityId, (cityCounts.get(cityId) || 0) + count);
      cityCountries.set(cityId, row.country_code);
    }
    let region = byId.get(Number(row.region_id));
    const seen = new Set<number>();
    while (region && !seen.has(Number(region.id))) {
      seen.add(Number(region.id));
      regionCounts.set(Number(region.id), (regionCounts.get(Number(region.id)) || 0) + count);
      region = region.parent_id == null ? undefined : byId.get(Number(region.parent_id));
    }
  }
  const result = new Map<string, CoverageLevelSummary[]>();
  for (const [countryCode, total] of totals) {
    if (countryCode === 'CN') continue;
    const labels = hierarchyLabels[countryCode] || [['First-level division', '一级行政区'], ['City', '城市']];
    const countryRegions = regions.filter((region) => region.country_code === countryCode);
    const levels: CoverageLevelSummary[] = [];
    const rootRegions = countryRegions.filter((region) => region.parent_id == null);
    levels.push({
      key: 'region', labelEn: labels[0][0], labelZh: labels[0][1], total: total.root,
      covered: rootRegions.filter((region) => (regionCounts.get(Number(region.id)) || 0) > 0).length,
      qualified: rootRegions.filter((region) => (regionCounts.get(Number(region.id)) || 0) >= 5).length
    });
    if (total.child) {
      const childRegions = countryRegions.filter((region) => region.parent_id != null);
      levels.push({
        key: 'subregion', labelEn: labels[1]?.[0] || 'Administrative area', labelZh: labels[1]?.[1] || '行政区', total: total.child,
        covered: childRegions.filter((region) => (regionCounts.get(Number(region.id)) || 0) > 0).length,
        qualified: childRegions.filter((region) => (regionCounts.get(Number(region.id)) || 0) >= 5).length
      });
    }
    const cityLabel = labels[total.child ? 2 : 1] || ['City', '城市'];
    const countryCities = [...cityCounts].filter(([id]) => cityCountries.get(id) === countryCode);
    levels.push({
      key: 'city', labelEn: cityLabel[0], labelZh: cityLabel[1], total: total.city,
      covered: countryCities.length,
      qualified: countryCities.filter(([, count]) => count >= 5).length
    });
    result.set(countryCode, levels);
  }
  const chinaRows = (await database.prepare(`SELECT level,COUNT(*) AS total,
    SUM(CASE WHEN total_count>0 THEN 1 ELSE 0 END) AS covered,
    SUM(CASE WHEN total_count>=5 THEN 1 ELSE 0 END) AS qualified
    FROM admin_coverage_stats WHERE country_code='CN' AND level BETWEEN 1 AND 3 GROUP BY level ORDER BY level`)
    .all<{ level: number; total: number; covered: number; qualified: number }>()).results;
  if (chinaRows.length) result.set('CN', chinaRows.map((row, index) => ({
    key: index === 0 ? 'region' : index === 1 ? 'city' : 'district',
    labelEn: hierarchyLabels.CN[index][0], labelZh: hierarchyLabels.CN[index][1],
    total: Number(row.total || 0), covered: Number(row.covered || 0), qualified: Number(row.qualified || 0)
  })));
  return result;
};

const catalogLevelLabel = (countryCode: string, depth: number): [string, string] => {
  const labels = hierarchyLabels[countryCode] || [['First-level division', '一级行政区'], ['City', '城市']];
  return labels[Math.min(depth - 1, labels.length - 1)] || labels[labels.length - 1];
};

const catalogRegions = async (database: Database, countryCode: string, parentId: number | null): Promise<CoverageNode[]> => {
  const [regionResult, coverageResult] = await Promise.all([
    database.prepare(`SELECT id,parent_id,code,name,native_name,zh_name,path FROM catalog_regions
      WHERE country_code=?`).bind(countryCode).all<Record<string, unknown>>(),
    database.prepare(`SELECT region_id,city_id,address_count,last_verified_at FROM residential_coverage
      WHERE country_code=? AND region_id IS NOT NULL`).bind(countryCode).all<Record<string, unknown>>()
  ]);
  const regions = regionResult.results as Array<Record<string, unknown>>;
  const rows: Array<Record<string, unknown>> = regions.filter((region) => parentId == null ? region.parent_id == null : Number(region.parent_id) === parentId)
    .map((region) => {
      const path = String(region.path || '').replace(/\/$/u, '');
      const descendantIds = new Set(regions
        .filter((candidate) => Number(candidate.id) === Number(region.id) || String(candidate.path || '').startsWith(`${path}/`))
        .map((candidate) => Number(candidate.id)));
      const coverage = coverageResult.results.filter((entry) => descendantIds.has(Number(entry.region_id)));
      const updatedAt = coverage.reduce((latest, entry) => {
        const value = String(entry.last_verified_at || '');
        return value > latest ? value : latest;
      }, '');
      return {
        ...region,
        address_count: coverage.reduce((total, entry) => total + Number(entry.address_count || 0), 0),
        region_children: regions.filter((candidate) => Number(candidate.parent_id) === Number(region.id)).length,
        city_children: new Set(coverage.map((entry) => entry.city_id).filter((id) => id != null)).size,
        updated_at: updatedAt
      };
    })
    .sort((left: Record<string, unknown>, right: Record<string, unknown>) => Number(right.address_count) - Number(left.address_count) || String(left.name).localeCompare(String(right.name)));
  return rows.map((row) => {
    const depth = parentId == null ? 1 : String(row.path || '').split('/').filter(Boolean).length;
    const label = catalogLevelLabel(countryCode, depth);
    const addressCount = Number(row.address_count || 0);
    return {
      key: `catalog-region:${row.id}`, countryCode, level: depth, levelLabel: label[1], levelLabelEn: label[0], levelLabelZh: label[1],
      regionCode: String(row.code || ''), regionName: String(row.native_name || row.name), regionNameEn: String(row.name),
      regionNameZh: String(row.zh_name || row.native_name || row.name), ordinaryCount: 0, residentialCount: addressCount,
      totalCount: addressCount, childCount: Number(row.region_children || row.city_children || 0),
      updatedAt: String(row.updated_at || nowIso())
    };
  });
};

const catalogChildren = async (database: Database, parentKey: string): Promise<CoverageNode[] | null> => {
  const match = parentKey.match(/^catalog-region:(\d+)$/u);
  if (!match) return null;
  const region = await database.prepare('SELECT id,country_code,path FROM catalog_regions WHERE id=?')
    .bind(Number(match[1])).first<{ id: number; country_code: string; path: string }>();
  if (!region) return [];
  const regions = await catalogRegions(database, region.country_code, region.id);
  if (regions.length) return regions;
  const label = (hierarchyLabels[region.country_code] || [['First-level division', '一级行政区'], ['City', '城市']]).at(-1)!;
  const rows = (await database.prepare(`SELECT city.id,city.name,city.native_name,city.zh_name,SUM(coverage.address_count) AS address_count,
      MAX(coverage.last_verified_at) AS updated_at
    FROM residential_coverage coverage JOIN catalog_cities city ON city.id=coverage.city_id
    WHERE coverage.country_code=? AND city.region_id=?
    GROUP BY city.id,city.name,city.native_name,city.zh_name ORDER BY address_count DESC,city.name`)
    .bind(region.country_code, region.id).all<Record<string, unknown>>()).results;
  return rows.map((row) => ({
    key: `catalog-city:${row.id}`, countryCode: region.country_code, level: 3, levelLabel: label[1], levelLabelEn: label[0], levelLabelZh: label[1],
    regionCode: '', regionName: String(row.native_name || row.name), regionNameEn: String(row.name),
    regionNameZh: String(row.zh_name || row.native_name || row.name), ordinaryCount: 0,
    residentialCount: Number(row.address_count || 0), totalCount: Number(row.address_count || 0), childCount: 0,
    updatedAt: String(row.updated_at || nowIso())
  }));
};

export const listAddressCoverage = async (database: Database, parentKey = ''): Promise<CoverageNode[]> => {
  const catalogChildRows = await catalogChildren(database, parentKey);
  if (catalogChildRows) return catalogChildRows;
  if (parentKey && parentKey !== 'CN' && hierarchyLabels[parentKey]) {
    const rows = await catalogRegions(database, parentKey, null);
    if (rows.length) return rows;
  }
  const rows = (await database.prepare(`SELECT node_key,country_code,level,region_code,region_name,ordinary_count,
    residential_count,total_count,child_count,updated_at FROM admin_coverage_stats WHERE parent_key=?
    ORDER BY total_count DESC,region_name`).bind(parentKey).all<Record<string, unknown>>()).results;
  const summaries = parentKey ? new Map<string, CoverageLevelSummary[]>() : await catalogCoverageSummaries(database);
  return rows.map((row) => ({
    key: String(row.node_key),
    countryCode: String(row.country_code),
    level: Number(row.level),
    levelLabel: coverageLevelLabel(String(row.country_code), Number(row.level)),
    regionCode: String(row.region_code || ''),
    regionName: String(row.region_name),
    ordinaryCount: Number(row.ordinary_count || 0),
    residentialCount: Number(row.residential_count || 0),
    totalCount: Number(row.total_count || 0),
    childCount: Number(row.level) === 0 && summaries.get(String(row.country_code))?.[0]
      ? Number(summaries.get(String(row.country_code))![0].total) : Number(row.child_count || 0),
    updatedAt: String(row.updated_at),
    coverageLevels: Number(row.level) === 0 ? summaries.get(String(row.country_code)) || [] : undefined
  }));
};
