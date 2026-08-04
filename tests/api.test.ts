import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedBundle, LocationOption } from '../src/domain/types';
import app from '../server/api/index';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { eligibleAddresses } from './fixtures/catalog';

const overpassMock = (country: string, city: string, index = 1) => JSON.stringify({ elements: [{
  type: 'way', id: Number(`${country.charCodeAt(0)}${country.charCodeAt(1)}${index}`),
  center: { lat: 34 + index / 100, lon: -118 - index / 100 },
  tags: {
    'addr:housenumber': String(100 + index), 'addr:street': `Dynamic Street ${index}`,
    'addr:city': city, 'addr:state': 'Dynamic Region', 'addr:postcode': `9000${index}`,
    building: 'apartments'
  }
}] });
const mockBindings = { ALLOWED_ORIGIN: '*', GOOGLE_TRANSLATION_ENABLED: false } as const;

afterEach(() => vi.unstubAllGlobals());

describe('synchronized address registry', () => {
  it('reports countries that still require a synchronized snapshot', async () => {
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*' });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: null; generationMode: string }> };
    expect(response.status).toBe(200);
    expect(payload.data).toHaveLength(27);
    expect(payload.data.every((country) => country.addressCount === null && country.generationMode === 'sync-required')).toBe(true);
  });

  it('reports v2 address and residential coverage from ADDRESS_DB', async () => {
    const statements: string[] = [];
    const addressDb = {
      prepare: (sql: string) => {
        statements.push(sql);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 10, residential: 8 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number; residentialAvailable: boolean; generationMode: string }> };
    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({
      addressCount: 8, residentialCount: 8, residentialAvailable: true, generationMode: 'synchronized-pool'
    });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('FROM sync_country_state');
    expect(statements[0]).not.toContain('address_pool_runtime');
    expect(statements[1]).toContain('cn_communities_v2');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('marks residential mode available when the evidence-backed pool is non-empty', async () => {
    const addressDb = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 5000, residential: 250 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    const payload = await response.json() as { data: Array<{ code: string; residentialAvailable: boolean }> };
    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({ residentialAvailable: true });
  });

  it('reads v2 counts from the synchronized country summary', async () => {
    const statements: string[] = [];
    const addressDb = {
      prepare: (sql: string) => {
        statements.push(sql);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 7, residential: 3 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number }> };

    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({ addressCount: 3, residentialCount: 3 });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('FROM sync_country_state');
    expect(statements[1]).toContain('cn_communities_v2');
  });

  it('serves lightweight availability from precomputed state', async () => {
    const statements: string[] = [];
    const addressDb = {
      prepare: (sql: string) => {
        statements.push(sql);
        return { all: async () => ({ results: [{ code: 'US', count: 8 }, { code: 'CN', count: 2 }] }) };
      }
    };
    const response = await app.request('/api/v1/availability', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    expect(await response.json()).toEqual({ data: [
      { code: 'US', residentialAvailable: true }, { code: 'CN', residentialAvailable: true }
    ] });
    expect(statements[0]).toContain('sync_country_state');
    expect(statements[0]).toContain('residential_coverage');
    expect(statements[0]).toContain('address_datasets');
    expect(statements[0]).toContain('HAVING MAX(count)>0');
    expect(statements[0]).not.toContain('address_pool_runtime');
    expect(response.headers.get('Cache-Control')).toContain('max-age=30');
  });

  it('lists hierarchy children and reports the three synchronization rules', async () => {
    const database = openTestDatabase(':memory:');
    const now = new Date().toISOString();
    try {
      await database.batch([
        database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
          VALUES (901,'US','CA','California','California','加利福尼亚州','state',NULL,'/901')`),
        database.prepare(`INSERT INTO sync_country_policies(
          country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,min_per_node,coverage_ratio,level1_min,level2_min,updated_at
        ) VALUES ('US',1,10,10,10,10,10,2,1,2,0,?)`).bind(now),
        database.prepare(`INSERT INTO admin_coverage_stats(
          node_key,parent_key,country_code,level,region_code,region_name,residential_count,total_count,child_count,updated_at
        ) VALUES ('US','','US',0,'US','United States',5,5,1,?)`).bind(now),
        database.prepare(`INSERT INTO admin_coverage_stats(
          node_key,parent_key,country_code,level,region_code,region_name,residential_count,total_count,child_count,updated_at
        ) VALUES ('US:1:CA','US','US',1,'CA','California',1,1,0,?)`).bind(now)
      ]);
      const hierarchy = await app.request('/api/v1/locations/hierarchy?country=US&parentType=country&childType=region', {}, {
        ALLOWED_ORIGIN: '*', LOCATION_DB: database
      });
      const hierarchyPayload = await hierarchy.json() as { data: { children: LocationOption[] } };
      expect(hierarchy.status).toBe(200);
      expect(hierarchyPayload.data.children).toContainEqual(expect.objectContaining({ id: '901', value: 'California' }));

      const coverage = await app.request('/api/v1/coverage?country=US', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: database });
      const coveragePayload = await coverage.json() as { data: { countries: Array<{ unmetRules: string[]; rules: Record<string, unknown> }> } };
      expect(coverage.status).toBe(200);
      expect(coveragePayload.data.countries[0].unmetRules).toEqual(['total', 'administrative_coverage', 'regional_minimums']);
      expect(coveragePayload.data.countries[0].rules).toHaveProperty('total');
      expect(coveragePayload.data.countries[0].rules).toHaveProperty('administrativeCoverage');
      expect(coveragePayload.data.countries[0].rules).toHaveProperty('regionalMinimums');
    } finally {
      database.close();
    }
  });

  it('returns not found for an address ID outside the published synchronized pool', async () => {
    const response = await app.request('/api/v1/addresses/pool-v2-missing', {}, { ALLOWED_ORIGIN: '*' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'ADDRESS_NOT_FOUND' } });
  });

  it('counts each publishable residential runtime address once and rejects stale or invalid records', async () => {
    const database = openTestDatabase(':memory:');
    const observedAt = '2026-07-01T00:00:00Z';
    try {
      await database.prepare(`INSERT INTO address_sources VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        'fixture-source', 'Fixture source', 'https://example.test', 'https://example.test/data', 'fixture', 'Fixture',
        'https://example.test/license', 'Fixture attribution', 'https://example.test/attribution',
        'https://example.test/terms', 0, 0, 1, '{}', observedAt, observedAt
      ).run();
      for (const [id, version, checksum] of [['dataset-a', '1', 'a'.repeat(64)]]) {
        await database.prepare(`INSERT INTO address_datasets(
          id,source_id,country_code,version,published_at,retrieved_at,imported_at,input_checksum,format,
          license_code,license_name,license_url,attribution_text,attribution_url,terms_url,
          share_alike,notice_required,redistribution_allowed,status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          id, 'fixture-source', 'US', version, observedAt, observedAt, observedAt, checksum, 'fixture',
          'fixture', 'Fixture', 'https://example.test/license', 'Fixture attribution',
          'https://example.test/attribution', 'https://example.test/terms', 0, 0, 1, 'active'
        ).run();
      }
      const insertAddress = async (id: string, expiresAt: string | null, residentialEvidence: boolean) => {
        const components = { houseNumber: '10', street: 'Market Street', locality: 'Philadelphia', admin1: 'Pennsylvania', admin1Code: 'PA', postcode: '19103' };
        await database.prepare(`INSERT INTO address_pool(
          id,country_code,admin1,admin1_code,locality,postal_locality,postcode,street,house_number,
          latitude,longitude,native_language,component_variants_json,address_variants_json,
          property_type,quality_score,generation,coverage,random_key,first_seen_at,last_seen_at,expires_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          id, 'US', 'Pennsylvania', 'PA', 'Philadelphia', 'Philadelphia', '19103', 'Market Street', '10',
          39.95, -75.16, 'en', JSON.stringify({ native: components, en: components, 'zh-CN': components }),
          JSON.stringify({ native: '10 Market Street, Philadelphia, PA 19103', en: '10 Market Street, Philadelphia, PA 19103', 'zh-CN': '美国宾夕法尼亚州费城市场街10号' }),
          'residential', 0.95, 'fixture', 'US:PA:Philadelphia', 1, observedAt, observedAt, expiresAt
        ).run();
        await database.prepare('INSERT INTO address_pool_evidence VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
          `${id}-dataset-a-address`, id, 'dataset-a', `${id}-record`, '', observedAt, 'address_existence', 1, 1, observedAt
        ).run();
        if (residentialEvidence) {
          await database.prepare('INSERT INTO address_pool_evidence VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
            `${id}-residential`, id, 'dataset-a', `${id}-building`, '', observedAt, 'residential_use', 0, 1, observedAt
          ).run();
        }
      };
      await insertAddress('valid', '2099-01-01T00:00:00Z', true);
      await insertAddress('expired', '2000-01-01T00:00:00Z', true);
      await insertAddress('invalid-date', 'not-a-date', true);
      await insertAddress('no-residential-evidence', null, false);

      expect((await database.prepare(`SELECT id,residential_evidence FROM address_pool_runtime
        ORDER BY id`).all()).results).toEqual([
        { id: 'expired', residential_evidence: 1 },
        { id: 'invalid-date', residential_evidence: 1 },
        { id: 'no-residential-evidence', residential_evidence: 0 },
        { id: 'valid', residential_evidence: 1 }
      ]);
      expect(await database.prepare(`SELECT id FROM address_pool_runtime WHERE id='valid'
        AND expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
        AND expires_at::timestamptz > ?::timestamptz`).bind(new Date().toISOString()).first('id')).toBe('valid');
      await database.prepare(`INSERT INTO sync_country_state(country_code,status,address_count,residential_count,updated_at)
        VALUES ('US','ready',1,1,?) ON CONFLICT(country_code) DO UPDATE SET
        status='ready',address_count=1,residential_count=1,updated_at=excluded.updated_at`).bind(observedAt).run();
      const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: database });
      const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number }> };
      expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({ addressCount: 1, residentialCount: 1 });
    } finally {
      database.close();
    }
  });

  it('does not advertise legacy residential coverage when the active pool has none', async () => {
    const legacyDb = {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: sql.includes('residential_coverage')
            ? [{ country_code: 'US', total: 13 }]
            : [{ country_code: 'US', total: 50 }] })
        };
        return statement;
      }
    };
    const addressDb = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 10, residential: 0 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, {
      ALLOWED_ORIGIN: '*', LOCATION_DB: legacyDb, ADDRESS_DB: addressDb
    });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number; residentialAvailable: boolean }> };
    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({
      addressCount: 0, residentialCount: 0, residentialAvailable: false
    });
  });

  it('returns configured region and city discovery options without reading address snapshots', async () => {
    const regions = await app.request('/api/v1/locations/search?country=US&field=region', {}, { ALLOWED_ORIGIN: '*' });
    const regionPayload = await regions.json() as { data: { regions: LocationOption[] } };
    const cities = await app.request('/api/v1/locations/search?country=US&field=city', {}, { ALLOWED_ORIGIN: '*' });
    const cityPayload = await cities.json() as { data: { cities: LocationOption[] } };
    expect(regionPayload.data.regions).toContainEqual(expect.objectContaining({
      value: 'California', label: 'California（CA）加利福尼亚州', en: 'California', zhCN: '加利福尼亚州'
    }));
    expect(cityPayload.data.cities.map((item) => item.value)).toContain('Los Angeles');
    expect(cityPayload.data.cities.map((item) => item.value)).toContain('Chicago');
  });
});

describe('pool-only and IP address generation', () => {
  it('uses the unified database selector before legacy country-specific queries', async () => {
    const address = eligibleAddresses('US', true, new Date('2026-01-01T00:00:00Z'))[0];
    const pick = vi.fn(async () => ({
      ready: true as const,
      result: { address, source: 'address-pool-v2' as const, eligibleCount: 12_345 }
    }));
    const response = await app.request(
      '/api/v1/generate?country=US&residential=true&seed=database-seed&requestId=database-request',
      {},
      { ...mockBindings, RANDOM_ADDRESS_SERVICE: { pick } }
    );
    const payload = await response.json() as {
      data: { eligibleCount: number; sourcesTried: string[]; result: GeneratedBundle }
    };

    expect(response.status).toBe(200);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ countryCode: 'US', seed: 'database-seed' }));
    expect(payload.data.eligibleCount).toBe(12_345);
    expect(payload.data.sourcesTried).toEqual(['address-pool-v2']);
    expect(payload.data.result.address.id).toBe(address.id);
  });

  it('batch-generates unique database records with structured filters', async () => {
    const base = eligibleAddresses('US', true, new Date('2026-01-01T00:00:00Z'))[0];
    const pick = vi.fn(async ({ seed }: { seed: string }) => ({
      ready: true as const,
      result: { address: { ...base, id: `pool-v2-${seed}` }, source: 'address-pool-v2' as const, eligibleCount: 10_000 }
    }));
    const response = await app.request('/api/v1/generate/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: 3,
        filters: { country: 'US', region: 'California', q: 'Street' },
        options: { unique: true, seed: 'batch-seed', strategy: 'instant', requestId: 'batch-request' },
        excludeAddressIds: []
      })
    }, { ...mockBindings, RANDOM_ADDRESS_SERVICE: { pick } });
    const payload = await response.json() as { data: { requestedCount: number; returnedCount: number; unique: boolean; exhausted: boolean; results: GeneratedBundle[] } };
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({ requestedCount: 3, returnedCount: 3, unique: true, exhausted: false });
    expect(new Set(payload.data.results.map((result) => result.address.id)).size).toBe(3);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({
      countryCode: 'US', filters: expect.objectContaining({ region: 'California', q: 'Street' })
    }));
  });

  it('rejects batch sizes above the public limit', async () => {
    const response = await app.request('/api/v1/generate/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 51, filters: { country: 'US' } })
    }, mockBindings);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_BATCH_REQUEST' } });
  });

  it('does not enter an online provider when a regular synchronized pool misses', async () => {
    const response = await app.request('/api/v1/generate?country=US&residential=false&city=Chicago', {}, {
      ...mockBindings, OVERPASS_MOCK: overpassMock('US', 'Chicago')
    });
    const payload = await response.json() as { error: { code: string } };
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('NO_POOL_COVERAGE');
  });

  it('does not query a live address provider for an explicit IP-region request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      country_code: 'US', region: 'Dynamic Region', city: 'Chicago',
      latitude: 41.8781, longitude: -87.6298
    })));
    const response = await app.request('/api/v1/generate?mode=ip-region&ip=8.8.8.8&residential=true&live=true&requestId=res-1', {}, {
      ...mockBindings, OVERPASS_MOCK: overpassMock('US', 'Chicago')
    });
    const payload = await response.json() as { error: { code: string } };
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('IP_REGION_NO_RESULT');
  });

  it('returns prelocalized v2 rows without entering the localization network path', async () => {
    const components = { houseNumber: '4-27-7', street: '永福四丁目', locality: '杉並区', admin1: '東京都', admin1Code: '13', postcode: '168-0064' };
    const row = {
      id: 'jp-hot', country_code: 'JP', admin1: '東京都', admin1_code: '13', locality: '杉並区', postal_locality: '杉並区',
      district: '永福', postcode: '168-0064', street: '永福四丁目', house_number: '4-27-7', building_name: '', latitude: 35.676,
      longitude: 139.642, native_language: 'ja', property_type: 'residential', generation: 'test', quality_score: 0.95,
      first_seen_at: '2026-07-15T00:00:00Z', expires_at: '2027-07-15T00:00:00Z',
      component_variants_json: JSON.stringify({ native: components, en: { ...components, street: 'Eifuku', locality: 'Suginami' }, 'zh-CN': { ...components, locality: '杉并区' } }),
      address_variants_json: JSON.stringify({ native: '東京都杉並区永福四丁目4-27-7', en: '4-27-7 Eifuku, Suginami, Tokyo 168-0064', 'zh-CN': '东京都杉并区永福四丁目4-27-7' }),
      source_id: 'fixture', source_name: 'Fixture', source_url: 'https://example.test', source_record_id: 'jp-hot',
      observed_at: '2026-07-15T00:00:00Z', evidence_type: 'address_existence', dataset_id: 'fixture-v2', dataset_version: 'test',
      source_updated_at: '2026-07-15T00:00:00Z', imported_at: '2026-07-16T00:00:00Z', residential_evidence: 1
    };
    const addressDb = {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: sql.startsWith('SELECT id FROM address_pool')
            ? sql.includes('random_key >=') ? [{ id: row.id }] : []
            : sql.includes('FROM address_pool_runtime') ? [row] : [] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/generate?country=JP&strategy=instant&seed=hot&requestId=hot', {}, {
      ...mockBindings, ADDRESS_DB: addressDb
    });
    const payload = await response.json() as { data: { sourcesTried: string[]; result: GeneratedBundle } };
    expect(payload.data.sourcesTried).toEqual(['address-pool-v2']);
    expect(payload.data.result.address.addressVariants.en).toContain('Eifuku');
    expect(response.headers.get('Server-Timing')).toMatch(/localize;dur=0\.0/);
  });

  it('returns a dedicated coverage error instead of a generic provider timeout', async () => {
    const response = await app.request('/api/v1/generate?country=US&city=Chicago', {}, {
      ...mockBindings, OVERPASS_MOCK: JSON.stringify({ elements: [] })
    });
    const payload = await response.json() as { error: { code: string } };
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('NO_POOL_COVERAGE');
  });
});
