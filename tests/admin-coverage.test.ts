import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAddressCoverage, refreshAddressCoverage } from '../server/control/coverage';
import { openDatabase, type SqliteDatabase } from '../server/database/sqlite.mjs';

describe('admin address coverage', () => {
  let database: SqliteDatabase;

  beforeEach(() => { database = openDatabase(':memory:'); });
  afterEach(() => database.close());

  it('builds country-first China province, city, and district drill-down statistics', async () => {
    const now = new Date().toISOString();
    await database.batch([
      database.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES ('110000',NULL,'province','北京市','北京市','fixture',?)`).bind(now),
      database.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES ('110100','110000','city','北京市','北京市/北京市','fixture',?)`).bind(now),
      database.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES ('110105','110100','district','朝阳区','北京市/北京市/朝阳区','fixture',?)`).bind(now),
      database.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,provider_address,
        longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
        VALUES ('community','望京花园','望京','北京市','北京市','朝阳区','阜通东大街6号',116.46,39.98,'L1',1,?,?,?)`).bind(now, now, now),
      database.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at)
        VALUES ('amap','amap-poi','community','望京花园','阜通东大街6号',116.46,39.98,'GCJ-02',?,?,?)`)
        .bind('a'.repeat(64), now, now)
    ]);
    await refreshAddressCoverage(database);
    const countries = await listAddressCoverage(database);
    const china = countries.find((item) => item.countryCode === 'CN');
    expect(china).toMatchObject({ regionName: '中国', residentialCount: 1, totalCount: 1, childCount: 1 });
    const provinces = await listAddressCoverage(database, china?.key);
    expect(provinces[0]).toMatchObject({ regionName: '北京市', levelLabel: '省级', residentialCount: 1 });
    const cities = await listAddressCoverage(database, provinces[0].key);
    expect(cities[0]).toMatchObject({ regionName: '北京市', levelLabel: '地级市', residentialCount: 1 });
    const districts = await listAddressCoverage(database, cities[0].key);
    expect(districts[0]).toMatchObject({ regionName: '朝阳区', levelLabel: '区县', residentialCount: 1 });
  });
});
