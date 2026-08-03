import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { refreshResidentialCoverage } from '../server/database/residential-coverage.mjs';
import { queryLocationCatalog } from '../server/api/repositories/location-catalog';

describe('published residential coverage', () => {
  let database;
  const now = '2026-07-29T00:00:00.000Z';

  beforeEach(async () => {
    database = openTestDatabase(':memory:');
    await database.batch([
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (1,'US','NY','New York','New York','纽约州','state',NULL,'/1')`),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (2,'US','CA','California','California','加利福尼亚州','state',NULL,'/2')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (11,'US',1,'New York City','New York City','纽约市','city',8000000)`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (12,'US',2,'Los Angeles','Los Angeles','洛杉矶','city',3900000)`),
      database.prepare(`INSERT INTO address_sources(id,name,homepage_url,data_url,license_code,license_name,license_url,
        attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,created_at,updated_at)
        VALUES ('source','Fixture','https://example.test','https://example.test/data','CC0','CC0','https://example.test/license',
        'Fixture','https://example.test','https://example.test/terms',0,0,1,?,?)`).bind(now, now),
      database.prepare(`INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
        format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
        redistribution_allowed,status) VALUES ('dataset','source','US','fixture',?,?,?,'jsonl','CC0','CC0',
        'https://example.test/license','Fixture','https://example.test','https://example.test/terms',0,0,1,'active')`)
        .bind(now, now, 'a'.repeat(64))
    ]);
    for (const [id, admin1, city, postcode, longitude] of [
      ['ny', 'NY', 'New York City', '10001', -73.99],
      ['ca', 'California', 'Los Angeles', '90001', -118.24]
    ]) {
      const components = { houseNumber: '1', street: 'Main Street', locality: city, postalLocality: city, admin1, postcode };
      await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,postal_locality,postcode,street,
        house_number,latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,
        quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at)
        VALUES (?,'US',?,?,?,?, 'Main Street','1',40,?,'en',?,?,'residential',.95,'fixture',?,1,1,?,?)`)
        .bind(id, admin1, city, city, postcode, longitude, JSON.stringify({ native: components, en: components, 'zh-CN': components }),
          JSON.stringify({ native: '1 Main Street', en: '1 Main Street', 'zh-CN': '1 Main Street' }), `${admin1}:${city}`, now, now).run();
      await database.batch(['address_existence', 'residential_use'].map((type, index) => database.prepare(`
        INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,
          is_primary,is_current,created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
        .bind(`${id}-${type}`, id, 'dataset', id, now, type, index === 0 ? 1 : 0, now)));
    }
  });
  afterEach(() => database.close());

  it('replaces seed rows with all official regions and cities backed by strict addresses', async () => {
    await database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
      VALUES ('US','New York','New York City',99,?,1,11)`).bind(now).run();
    await database.batch([
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (3,'US','CA2','California','California','加利福尼亚州','state',NULL,'/3')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (13,'US',3,'Los Angeles','Los Angeles','洛杉矶','city',3900000)`),
      database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,postal_locality,postcode,street,
        house_number,latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,
        quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at)
        SELECT 'ca-duplicate',country_code,'CA2',locality,postal_locality,postcode,street,house_number,latitude,longitude,
          native_language,component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,
          random_key,active,first_seen_at,last_seen_at FROM address_pool WHERE id='ca'`),
      ...['address_existence', 'residential_use'].map((type, index) => database.prepare(`
        INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,
        is_primary,is_current,created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
        .bind(`ca-duplicate-${type}`, 'ca-duplicate', 'dataset', 'ca-duplicate', now, type, index === 0 ? 1 : 0, now))
    ]);
    const result = await refreshResidentialCoverage(database, 'US', now);
    expect(result).toMatchObject({ matchedAddresses: 3, unmatchedAddresses: 0, mappedGroups: 2 });
    const regions = await queryLocationCatalog(database, { country: 'US', field: 'region', residential: true, limit: 100 });
    const cities = await queryLocationCatalog(database, { country: 'US', field: 'city', residential: true, limit: 100 });
    expect(regions.options.map((item) => item.value)).toEqual(['California', 'New York']);
    expect(cities.options.map((item) => item.value)).toEqual(['New York City', 'Los Angeles']);
  });

  it('exposes covered top-level regions when addresses link to a child division', async () => {
    await database.batch([
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (20,'FR','IDF','Île-de-France','Île-de-France','法兰西岛大区','region',NULL,'/20/')`),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (21,'FR','75','Paris','Paris','巴黎省','department',20,'/20/21/')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (22,'FR',21,'Paris','Paris','巴黎','city',2100000)`),
      database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
        VALUES ('FR','Paris','Paris',5,?,21,22)`).bind(now)
    ]);
    const regions = await queryLocationCatalog(database, { country: 'FR', field: 'region', residential: true, limit: 100 });
    expect(regions.options.map((item) => item.value)).toEqual(['Île-de-France']);
  });
});
