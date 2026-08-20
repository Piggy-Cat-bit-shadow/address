import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { applyAdministrativeCatalogOverrides } from '../server/database/administrative-catalog-overrides';
import { queryLocationCatalog } from '../server/api/repositories/location-catalog';
import { evaluateCountryGoals } from '../server/sync/country-goals.mjs';
import {
  hongKongDistricts,
  hongKongRegions,
  validateHongKongAdministrativeHierarchy
} from '../src/domain/hk-administrative-divisions.mjs';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';

const regions = JSON.parse(await readFile(new URL('../src/domain/regions.json', import.meta.url), 'utf8'));

describe('Hong Kong administrative catalog', () => {
  it('uses the three official geographic regions as first-level divisions', () => {
    expect(regions.filter((region) => region.countryCode === 'HK')).toEqual([
      { countryCode: 'HK', name: 'Hong Kong Island', native: '香港島', zh: '香港岛', code: 'HK' },
      { countryCode: 'HK', name: 'Kowloon', native: '九龍', zh: '九龙', code: 'KLN' },
      { countryCode: 'HK', name: 'New Territories', native: '新界', zh: '新界', code: 'NT' }
    ]);
  });

  it('defines all 18 official districts with the correct geographic region', () => {
    expect(hongKongRegions.map(({ code }) => code)).toEqual(['HK', 'KLN', 'NT']);
    expect(hongKongDistricts).toHaveLength(18);
    expect(new Set(hongKongDistricts.map(({ code }) => code))).toEqual(new Set([
      'CW', 'EST', 'ILD', 'KLC', 'KC', 'KT', 'NTH', 'SK', 'ST', 'SSP', 'STH', 'TP', 'TW', 'TM', 'WC', 'WTS', 'YTM', 'YL'
    ]));
    expect(hongKongDistricts.filter(({ regionCode }) => regionCode === 'HK').map(({ native }) => native))
      .toEqual(['中西區', '東區', '南區', '灣仔區']);
    expect(hongKongDistricts.filter(({ regionCode }) => regionCode === 'KLN').map(({ native }) => native))
      .toEqual(['九龍城區', '觀塘區', '深水埗區', '黃大仙區', '油尖旺區']);
    expect(hongKongDistricts.filter(({ regionCode }) => regionCode === 'NT')).toHaveLength(9);
  });

  it('rejects neighborhoods and mismatched region/district pairs', () => {
    expect(validateHongKongAdministrativeHierarchy('香港島', '灣仔區')).toEqual({ valid: true });
    expect(validateHongKongAdministrativeHierarchy('Hong Kong', 'Wan Chai District')).toEqual({ valid: true });
    expect(validateHongKongAdministrativeHierarchy('九龍', '灣仔區')).toEqual({
      valid: false, reason: 'mismatched-hk-hierarchy'
    });
    expect(validateHongKongAdministrativeHierarchy('香港島', '金鐘')).toEqual({
      valid: false, reason: 'invalid-hk-district'
    });
  });

  it('replaces a legacy catalog and scopes filters and coverage to the official hierarchy', async () => {
    const database = openTestDatabase(':memory:');
    const now = new Date().toISOString();
    try {
      await database.batch([
        database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
          VALUES (1,'HK','HWC','Wan Chai','Wan Chai','湾仔','district',NULL,'/1/')`),
        database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
          VALUES (2,'HK',1,'Admiralty','金鐘','金钟','city',NULL)`),
        database.prepare(`INSERT INTO sync_country_policies(
          country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,
          min_per_node,coverage_ratio,level1_min,level2_min,updated_at
        ) VALUES ('HK',1,20000,10000,2000,300,0,1,1,0,0,?)`).bind(now)
      ]);
      expect(await applyAdministrativeCatalogOverrides(database)).toBe(true);
      expect(await applyAdministrativeCatalogOverrides(database)).toBe(false);

      const regionCount = await database.prepare("SELECT COUNT(*) AS total FROM catalog_regions WHERE country_code='HK'").first();
      const districtCount = await database.prepare("SELECT COUNT(*) AS total FROM catalog_cities WHERE country_code='HK'").first();
      expect(Number(regionCount.total)).toBe(3);
      expect(Number(districtCount.total)).toBe(18);

      const hongKongIsland = hongKongRegions.find(({ code }) => code === 'HK');
      const wanChai = hongKongDistricts.find(({ code }) => code === 'WC');
      await database.prepare(`INSERT INTO residential_coverage(
        country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id
      ) VALUES ('HK',?,?,?,?,?,?)`).bind(
        hongKongIsland.name, wanChai.name, 10, now, hongKongIsland.id, wanChai.id
      ).run();

      const regionsPage = await queryLocationCatalog(database, { country: 'HK', field: 'region', residential: false });
      expect(regionsPage.options.map(({ native }) => native)).toEqual(['香港島', '九龍', '新界']);
      const districtsPage = await queryLocationCatalog(database, {
        country: 'HK', field: 'city', regionId: String(hongKongIsland.id), residential: false
      });
      expect(districtsPage.options.map(({ native }) => native)).toEqual(['中西區', '東區', '南區', '灣仔區']);
      expect(districtsPage.options.some(({ native }) => native === '金鐘')).toBe(false);

      const goal = (await evaluateCountryGoals(database)).get('HK');
      expect(goal.rules.administrativeCoverage).toMatchObject({ covered: 1, total: 18, met: false });
      expect(goal.rules.regionalMinimums.lowest).toMatchObject({ qualified: 1, total: 18 });
    } finally {
      await database.close();
    }
  });
});
