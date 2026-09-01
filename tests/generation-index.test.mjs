import { describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { refreshAddressGenerationIndex } from '../server/database/generation-index.mjs';
import { pickAddressPoolV2Address } from '../server/api/repositories/address-pool-v2.ts';

describe('address generation index', () => {
  it('materializes only publishable rows and marks residential evidence', async () => {
    const database = openTestDatabase(':memory:');
    try {
      await database.prepare(`INSERT INTO address_sources(
        id,name,homepage_url,data_url,license_code,license_name,license_url,attribution_text,
        attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,metadata_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-source', 'Fixture', 'https://example.test', 'https://example.test/data', 'fixture', 'Fixture',
        'https://example.test/license', 'Fixture', 'https://example.test', 'https://example.test/terms',
        0, 0, 1, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      ).run();
      await database.prepare(`INSERT INTO address_datasets(
        id,source_id,country_code,version,published_at,retrieved_at,imported_at,input_checksum,format,
        license_code,license_name,license_url,attribution_text,attribution_url,terms_url,
        share_alike,notice_required,redistribution_allowed,status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-dataset', 'fixture-source', 'US', 'v1', null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
        'a'.repeat(64), 'jsonl', 'fixture', 'Fixture', 'https://example.test/license', 'Fixture',
        'https://example.test', 'https://example.test/terms', 0, 0, 1, 'active'
      ).run();
      await database.prepare(`INSERT INTO address_pool(
        id,country_code,admin1,admin1_code,locality,postal_locality,district,postcode,street,house_number,
        building_name,latitude,longitude,native_language,component_variants_json,address_variants_json,
        admin1_key,admin1_code_key,locality_key,postal_locality_key,district_key,postcode_key,property_type,
        quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,expires_at,retired_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-address', 'US', 'California', 'CA', 'Berkeley', 'Berkeley', '', '94704', 'College Avenue', '2704',
        '', 37.86, -122.25, 'en', JSON.stringify({ native: {}, en: {}, 'zh-CN': { street: '学院大道', locality: '伯克利' } }),
        JSON.stringify({ native: '2704 College Avenue', en: '2704 College Avenue', 'zh-CN': '美国加利福尼亚州伯克利学院大道2704号' }),
        'california', 'ca', 'berkeley', 'berkeley', '', '94704', 'residential', 0.95, 'fixture', 'fixture',
        42, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', null, null
      ).run();
      await database.prepare(`INSERT INTO address_pool_evidence(
        id,address_id,dataset_id,source_record_id,record_url,observed_at,evidence_type,is_primary,is_current,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-existence', 'fixture-address', 'fixture-dataset', 'fixture-address', 'https://example.test/address',
        '2026-01-01T00:00:00Z', 'address_existence', 1, 1, '2026-01-01T00:00:00Z'
      ).run();
      await database.prepare(`INSERT INTO address_pool_evidence(
        id,address_id,dataset_id,source_record_id,record_url,observed_at,evidence_type,is_primary,is_current,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        'fixture-residential', 'fixture-address', 'fixture-dataset', 'fixture-address', 'https://example.test/address',
        '2026-01-01T00:00:00Z', 'residential_use', 0, 1, '2026-01-01T00:00:00Z'
      ).run();
      expect(await refreshAddressGenerationIndex(database, 'US')).toBe(1);
      const row = await database.prepare(`SELECT address_id,country_rank,residential_rank,
        residential_ready,search_text FROM address_generation_index`).first();
      expect(row).toMatchObject({
        address_id: 'fixture-address', country_rank: 1, residential_rank: 1, residential_ready: 1
      });
      expect(row.search_text).toContain('college avenue');
      await expect(pickAddressPoolV2Address(database, 'US', true, {}, undefined, 'generation-seed'))
        .resolves.toMatchObject({ id: 'pool-v2-fixture-address' });
    } finally {
      database.close();
    }
  });
});
