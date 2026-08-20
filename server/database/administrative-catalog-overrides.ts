import { hongKongDistricts, hongKongRegions } from '../../src/domain/hk-administrative-divisions.mjs';
import type { PostgresDatabase } from './postgres.mjs';

const canonicalHongKongCatalog = async (database: PostgresDatabase): Promise<boolean> => {
  const [regions, districts, postcodes] = await Promise.all([
    database.prepare(`SELECT id,code,name,native_name,zh_name,type,parent_id,path FROM catalog_regions
      WHERE country_code='HK' ORDER BY id`).all<Record<string, unknown>>(),
    database.prepare(`SELECT id,region_id,name,native_name,zh_name,type FROM catalog_cities
      WHERE country_code='HK' ORDER BY id`).all<Record<string, unknown>>(),
    database.prepare("SELECT COUNT(*) AS total FROM catalog_postcodes WHERE country_code='HK'").first<{ total: number }>()
  ]);
  const expectedRegions = hongKongRegions.map((region) => ({
    id: region.id, code: region.code, name: region.name, native_name: region.native, zh_name: region.zh,
    type: 'region', parent_id: null, path: `/${region.id}/`
  }));
  const regionIds = new Map(hongKongRegions.map((region) => [region.code, region.id]));
  const expectedDistricts = hongKongDistricts.map((district) => ({
    id: district.id, region_id: regionIds.get(district.regionCode), name: district.name,
    native_name: district.native, zh_name: district.zh, type: 'district'
  }));
  return JSON.stringify(regions.results || []) === JSON.stringify(expectedRegions)
    && JSON.stringify(districts.results || []) === JSON.stringify(expectedDistricts)
    && Number(postcodes?.total || 0) === 0;
};

export const applyAdministrativeCatalogOverrides = async (database: PostgresDatabase): Promise<boolean> => {
  const catalogIsCanonical = await canonicalHongKongCatalog(database);
  const regionIds = new Map(hongKongRegions.map((region) => [region.code, region.id]));
  let changed = false;
  await database.transaction(async (transaction) => {
    const cleanup = await transaction.prepare(`UPDATE address_pool SET
        locality=REPLACE(locality,' &',''), postal_locality=REPLACE(postal_locality,' &',''),
        component_variants_json=REPLACE(component_variants_json,'中西區 &','中西區'),
        address_variants_json=REPLACE(address_variants_json,'中西區 &','中西區')
      WHERE country_code='HK' AND (
        locality LIKE '%&' OR postal_locality LIKE '%&'
        OR component_variants_json LIKE '%中西區 &%' OR address_variants_json LIKE '%中西區 &%'
      )`).run();
    changed ||= Number(cleanup.meta?.changes || 0) > 0;
    if (catalogIsCanonical) return;
    changed = true;
    await transaction.prepare("DELETE FROM residential_coverage WHERE country_code='HK'").run();
    await transaction.prepare("DELETE FROM catalog_postcodes WHERE country_code='HK'").run();
    await transaction.prepare("DELETE FROM catalog_cities WHERE country_code='HK'").run();
    await transaction.prepare("DELETE FROM catalog_regions WHERE country_code='HK'").run();
    await transaction.batch(hongKongRegions.map((region) => transaction.prepare(`INSERT INTO catalog_regions(
        id,country_code,code,name,native_name,zh_name,type,parent_id,path,latitude,longitude
      ) VALUES (?,'HK',?,?,?,?, 'region',NULL,?,NULL,NULL)`).bind(
        region.id, region.code, region.name, region.native, region.zh, `/${region.id}/`
      )));
    await transaction.batch(hongKongDistricts.map((district) => transaction.prepare(`INSERT INTO catalog_cities(
        id,country_code,region_id,name,native_name,zh_name,type,population,latitude,longitude
      ) VALUES (?,'HK',?,?,?,?, 'district',NULL,NULL,NULL)`).bind(
        district.id, regionIds.get(district.regionCode), district.name, district.native, district.zh
      )));
  });
  return changed;
};
