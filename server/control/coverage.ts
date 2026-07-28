import type { SqliteDatabase } from '../database/sqlite.mjs';
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
}

export const coverageLevelLabel = (countryCode: string, level: number): string =>
  levelLabels[countryCode]?.[level] || ['国家', '一级行政区', '城市', '区县', '下级区域'][level] || '区域';

const poolEvidenceClause = (alias: string, type: 'address_existence' | 'residential_use'): string => `EXISTS (
  SELECT 1 FROM address_pool_evidence evidence
  JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
    AND dataset.status='active' AND dataset.redistribution_allowed=1
  JOIN address_sources source ON source.id=dataset.source_id AND source.redistribution_allowed=1
  WHERE evidence.address_id=${alias}.id AND evidence.evidence_type='${type}' AND evidence.is_current=1
)`;

const strictResidentialPoolClause = (alias = 'address_pool'): string => [
  `${alias}.active=1`,
  `${alias}.property_type IN ('residential','apartment')`,
  `${alias}.quality_score>=0.7`,
  completenessClause(`${alias}.`),
  `(${alias}.expires_at IS NULL OR (datetime(${alias}.expires_at) IS NOT NULL AND datetime(${alias}.expires_at)>datetime('now')))`,
  poolEvidenceClause(alias, 'address_existence'),
  poolEvidenceClause(alias, 'residential_use')
].join(' AND ');

export const refreshAddressCoverage = async (database: SqliteDatabase): Promise<void> => {
  const now = nowIso();
  const statements = [database.prepare('DELETE FROM admin_coverage_stats')];
  for (const country of countries) {
    statements.push(database.prepare(`INSERT INTO admin_coverage_stats(
      node_key,parent_key,country_code,level,region_code,region_name,updated_at) VALUES (?, '', ?, 0, ?, ?, ?)`)
      .bind(country.code, country.code, country.code, country.name['zh-CN'], now));
  }
  statements.push(
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      ordinary_count,residential_count,total_count,updated_at)
      SELECT country_code||':a1:'||hex(admin1),country_code,country_code,1,admin1,
        0,COUNT(*),COUNT(*),?
      FROM address_pool WHERE country_code<>'CN' AND admin1<>'' AND ${strictResidentialPoolClause()}
      GROUP BY country_code,admin1`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      ordinary_count,residential_count,total_count,updated_at)
      SELECT country_code||':loc:'||hex(admin1)||':'||hex(locality),country_code||':a1:'||hex(admin1),country_code,2,locality,
        0,COUNT(*),COUNT(*),?
      FROM address_pool WHERE country_code<>'CN' AND admin1<>'' AND locality<>'' AND ${strictResidentialPoolClause()}
      GROUP BY country_code,admin1,locality`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      ordinary_count,residential_count,total_count,updated_at)
      SELECT country_code||':dist:'||hex(admin1)||':'||hex(locality)||':'||hex(district),
        country_code||':loc:'||hex(admin1)||':'||hex(locality),country_code,3,district,
        0,COUNT(*),COUNT(*),?
      FROM address_pool WHERE country_code<>'CN' AND admin1<>'' AND locality<>'' AND district<>'' AND ${strictResidentialPoolClause()}
      GROUP BY country_code,admin1,locality,district`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_code,region_name,updated_at)
      SELECT 'CN:a1:'||hex(name),'CN','CN',1,adcode,name,? FROM cn_admin_areas WHERE level='province'
      ON CONFLICT(node_key) DO UPDATE SET region_code=excluded.region_code`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_code,region_name,updated_at)
      SELECT 'CN:loc:'||hex(parent.name)||':'||hex(area.name),'CN:a1:'||hex(parent.name),'CN',2,area.adcode,area.name,?
      FROM cn_admin_areas area JOIN cn_admin_areas parent ON parent.adcode=area.parent_adcode WHERE area.level='city'
      ON CONFLICT(node_key) DO UPDATE SET region_code=excluded.region_code`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_code,region_name,updated_at)
      SELECT 'CN:dist:'||hex(province.name)||':'||hex(city.name)||':'||hex(area.name),
        'CN:loc:'||hex(province.name)||':'||hex(city.name),'CN',3,area.adcode,area.name,?
      FROM cn_admin_areas area JOIN cn_admin_areas city ON city.adcode=area.parent_adcode
      JOIN cn_admin_areas province ON province.adcode=city.parent_adcode WHERE area.level='district'
      ON CONFLICT(node_key) DO UPDATE SET region_code=excluded.region_code`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      residential_count,total_count,updated_at)
      SELECT 'CN:a1:'||hex(province),'CN','CN',1,province,COUNT(*),COUNT(*),?
      FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')} GROUP BY province
      ON CONFLICT(node_key) DO UPDATE SET residential_count=excluded.residential_count,
        total_count=admin_coverage_stats.ordinary_count+excluded.residential_count,updated_at=excluded.updated_at`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      residential_count,total_count,updated_at)
      SELECT 'CN:loc:'||hex(province)||':'||hex(city),'CN:a1:'||hex(province),'CN',2,city,COUNT(*),COUNT(*),?
      FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')} GROUP BY province,city
      ON CONFLICT(node_key) DO UPDATE SET residential_count=excluded.residential_count,
        total_count=admin_coverage_stats.ordinary_count+excluded.residential_count,updated_at=excluded.updated_at`).bind(now),
    database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
      residential_count,total_count,updated_at)
      SELECT 'CN:dist:'||hex(province)||':'||hex(city)||':'||hex(district),
        'CN:loc:'||hex(province)||':'||hex(city),'CN',3,district,COUNT(*),COUNT(*),?
      FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')} AND district<>'' GROUP BY province,city,district
      ON CONFLICT(node_key) DO UPDATE SET residential_count=excluded.residential_count,
        total_count=admin_coverage_stats.ordinary_count+excluded.residential_count,updated_at=excluded.updated_at`).bind(now),
    database.prepare(`UPDATE admin_coverage_stats SET ordinary_count=(
        0),
      residential_count=CASE WHEN country_code='CN' THEN (SELECT COUNT(*) FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')})
        ELSE (SELECT COUNT(*) FROM address_pool WHERE address_pool.country_code=admin_coverage_stats.country_code AND ${strictResidentialPoolClause('address_pool')}) END
      WHERE level=0`),
    database.prepare('UPDATE admin_coverage_stats SET total_count=ordinary_count+residential_count WHERE level=0'),
    database.prepare(`UPDATE admin_coverage_stats AS node SET child_count=(
      SELECT COUNT(*) FROM admin_coverage_stats child WHERE child.parent_key=node.node_key)`)
  );
  await database.batch(statements);
};

export const listAddressCoverage = async (database: SqliteDatabase, parentKey = ''): Promise<CoverageNode[]> => {
  const rows = (await database.prepare(`SELECT node_key,country_code,level,region_code,region_name,ordinary_count,
    residential_count,total_count,child_count,updated_at FROM admin_coverage_stats WHERE parent_key=?
    ORDER BY total_count DESC,region_name`).bind(parentKey).all<Record<string, unknown>>()).results;
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
    childCount: Number(row.child_count || 0),
    updatedAt: String(row.updated_at)
  }));
};
