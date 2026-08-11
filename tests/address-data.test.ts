import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAddressData } from '../server/control/address-data';
import { openTestDatabase, type PostgresDatabase } from './helpers/postgres-test-database.mjs';

const now = '2026-08-01T00:00:00.000Z';

describe('address data aggregation', () => {
  let database: PostgresDatabase;

  beforeEach(async () => {
    database = openTestDatabase(':memory:');
    await database.batch([
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('US',1,10,20,10,5,0,?)`).bind(now),
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('JP',1,10,20,10,5,0,?)`).bind(now),
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('CN',1,20,20,10,5,5,?)`).bind(now),
      database.prepare(`INSERT INTO admin_coverage_stats(
        node_key,parent_key,country_code,level,region_name,residential_count,total_count,updated_at
      ) VALUES ('US','','US',0,'United States',12,12,?)`).bind(now),
      database.prepare(`INSERT INTO admin_coverage_stats(
        node_key,parent_key,country_code,level,region_name,residential_count,total_count,updated_at
      ) VALUES ('US:district:a','US','US',3,'A',3,3,?)`).bind(now),
      database.prepare(`INSERT INTO admin_coverage_stats(
        node_key,parent_key,country_code,level,region_name,residential_count,total_count,updated_at
      ) VALUES ('US:district:b','US','US',3,'B',7,7,?)`).bind(now),
      database.prepare(`INSERT INTO admin_coverage_stats(
        node_key,parent_key,country_code,level,region_name,residential_count,total_count,updated_at
      ) VALUES ('JP','','JP',0,'Japan',4,4,?)`).bind(now),
      database.prepare(`INSERT INTO admin_coverage_stats(
        node_key,parent_key,country_code,level,region_name,residential_count,total_count,updated_at
      ) VALUES ('CN','','CN',0,'China',8,8,?)`).bind(now),
      database.prepare(`INSERT INTO sync_country_state(country_code,status,next_sync_at,last_success_at,failure_count,updated_at)
        VALUES ('US','ready','2026-08-02T00:00:00.000Z','2026-08-01T00:00:00.000Z',0,?)`).bind(now),
      database.prepare(`INSERT INTO sync_country_state(country_code,status,failure_count,last_error,updated_at)
        VALUES ('JP','failed',1,'upstream failed',?)`).bind(now),
      database.prepare(`INSERT INTO sync_shard_state(
        shard_id,country_code,status,next_sync_at,last_success_at,address_count,residential_count,failure_count,updated_at
      ) VALUES ('US-a','US','ready','2026-08-02T00:00:00.000Z','2026-08-01T00:00:00.000Z',12,12,0,?)`).bind(now),
      database.prepare(`INSERT INTO sync_shard_state(
        shard_id,country_code,status,address_count,residential_count,failure_count,last_error,updated_at
      ) VALUES ('JP-a','JP','failed',4,4,1,'shard failed',?)`).bind(now)
    ]);
  });

  afterEach(() => database.close());

  it('reports strict residential totals and the lowest administrative coverage', async () => {
    const countries = await listAddressData(database);
    const unitedStates = countries.find((country) => country.countryCode === 'US');
    expect(unitedStates).toMatchObject({
      currentCount: 12,
      targetCount: 10,
      deficit: 0,
      status: 'below_target',
      lowestCoverage: { level: 3, covered: 2, qualified: 1, total: 2 }
    });
  });

  it('distinguishes terminal source shortage, failures, and China quota waits', async () => {
    await database.prepare(`UPDATE admin_coverage_stats SET residential_count=4,total_count=4 WHERE node_key='US'`).run();
    const countries = await listAddressData(database, {
      syncState: 'quota_wait',
      nextAttemptAt: '2026-09-01T00:00:00.000Z',
      waitReason: 'quota_reset'
    }, new Map([['US', 'source_limited']]));
    expect(countries.find((country) => country.countryCode === 'US')).toMatchObject({ status: 'source_limited', deficit: 6 });
    expect(countries.find((country) => country.countryCode === 'JP')).toMatchObject({ status: 'failed', lastError: 'shard failed' });
    expect(countries.find((country) => country.countryCode === 'CN')).toMatchObject({
      status: 'quota_wait',
      nextAttemptAt: '2026-09-01T00:00:00.000Z',
      lastError: 'quota_reset'
    });
  });

  it('surfaces the queue credential blocker ahead of stale shard failures', async () => {
    const countries = await listAddressData(database, undefined, new Map([['JP', {
      state: 'blocked',
      reason: 'missing_api_key:geoapify',
      nextAttemptAt: null
    }]]));
    expect(countries.find((country) => country.countryCode === 'JP')).toMatchObject({
      status: 'blocked',
      lastError: 'missing_api_key:geoapify'
    });
  });

  it('names the required China map keys when no provider is configured', async () => {
    const countries = await listAddressData(database, {
      syncState: 'blocked',
      waitReason: 'unconfigured'
    });
    expect(countries.find((country) => country.countryCode === 'CN')).toMatchObject({
      status: 'blocked',
      lastError: 'missing_api_key:china_maps'
    });
  });

  it('reports dual completion criteria for count and lowest-node coverage', async () => {
    const countries = await listAddressData(database);
    expect(countries.find((country) => country.countryCode === 'US')).toMatchObject({
      minPerNode: 5,
      coverageRatio: 1,
      level1Min: 0,
      level2Min: 0,
      countMet: true,
      coverageMet: false,
      coverageLowestRatio: 0.5,
      coverageLevel1Ratio: null,
      coverageLevel2Ratio: null,
      coverageActual: 0.5,
      targetState: 'below_target',
      pruneCandidates: 0
    });
    expect(countries.find((country) => country.countryCode === 'JP')).toMatchObject({
      countMet: false, coverageMet: false, coverageActual: 0, coverageLowestRatio: null, targetState: 'below_target'
    });
  });

  it('combines per-level floors and node overrides into the coverage ratio and prune counts', async () => {
    await database.batch([
      database.prepare(`UPDATE sync_country_policies SET min_per_node=3,level1_min=10 WHERE country_code='US'`),
      database.prepare(`INSERT INTO admin_coverage_stats(
        node_key,parent_key,country_code,level,region_name,residential_count,total_count,updated_at
      ) VALUES ('US:a1:AA','US','US',1,'State A',10,10,?)`).bind(now)
    ]);
    let unitedStates = (await listAddressData(database)).find((country) => country.countryCode === 'US');
    expect(unitedStates).toMatchObject({
      coverageLowestRatio: 1, coverageLevel1Ratio: 1, coverageLevel2Ratio: null,
      coverageActual: 1, countMet: true, coverageMet: true, targetState: 'met'
    });
    await database.batch([
      database.prepare(`INSERT INTO sync_node_overrides(node_key,country_code,level,min_count,updated_at)
        VALUES ('US:district:a','US',3,5,?)`).bind(now),
      database.prepare(`INSERT INTO sync_node_overrides(node_key,country_code,level,min_count,updated_at)
        VALUES ('US:district:b','US',3,4,?)`).bind(now)
    ]);
    unitedStates = (await listAddressData(database)).find((country) => country.countryCode === 'US');
    expect(unitedStates).toMatchObject({
      coverageLowestRatio: 0.5, coverageLevel1Ratio: 1, coverageActual: 0.5,
      coverageMet: false, targetState: 'below_target', pruneCandidates: 3
    });
    await database.prepare(`UPDATE admin_coverage_stats SET residential_count=8,total_count=8 WHERE node_key='US:a1:AA'`).run();
    unitedStates = (await listAddressData(database)).find((country) => country.countryCode === 'US');
    expect(unitedStates).toMatchObject({ coverageLevel1Ratio: 0, coverageActual: 0, coverageMet: false });
  });

  it('surfaces China coverage source exhaustion as source_limited even when the count target is met', async () => {
    await database.batch([
      database.prepare(`UPDATE admin_coverage_stats SET residential_count=20,total_count=20 WHERE node_key='CN'`),
      database.prepare(`INSERT INTO admin_coverage_stats(
        node_key,parent_key,country_code,level,region_code,region_name,residential_count,total_count,updated_at
      ) VALUES ('CN:dist:130208','CN:loc:1302','CN',3,'130208','空置区',0,0,?)`).bind(now)
    ]);
    const china = (await listAddressData(database, {
      syncState: 'source_limited',
      waitReason: 'coverage_sources_exhausted'
    })).find((country) => country.countryCode === 'CN');
    expect(china).toMatchObject({
      status: 'source_limited',
      countMet: true,
      coverageMet: false,
      targetState: 'source_limited',
      lastError: 'coverage_sources_exhausted'
    });
  });

  it('uses only mainland China administrative nodes in the completion denominator', async () => {
    await database.batch([
      database.prepare(`UPDATE admin_coverage_stats SET residential_count=20,total_count=20 WHERE node_key='CN'`),
      ...[
        ['CN:dist:130208', '130208', 5],
        ['CN:dist:810101', '810101', 0],
        ['CN:dist:820101', '820101', 0],
        ['CN:dist:710101', '710101', 0]
      ].map(([nodeKey, regionCode, count]) => database.prepare(`INSERT INTO admin_coverage_stats(
          node_key,parent_key,country_code,level,region_code,region_name,residential_count,total_count,updated_at
        ) VALUES (?,'CN','CN',3,?,'Fixture',?,?,?)`).bind(nodeKey, regionCode, count, count, now))
    ]);
    expect((await listAddressData(database)).find((country) => country.countryCode === 'CN')).toMatchObject({
      coverageMet: true,
      coverageActual: 1,
      lowestCoverage: { total: 1, qualified: 1 }
    });
  });

  it('aggregates source datasets without exposing credentials or retired active counts', async () => {
    const sourceValues = [
      'fixture-source', 'Fixture Source', 'https://source.example', 'https://source.example/data',
      'CC0-1.0', 'CC0', 'https://license.example', '', '', '', 0, 0, 1, '{}', now, now
    ];
    await database.prepare(`INSERT INTO address_sources(
      id,name,homepage_url,data_url,license_code,license_name,license_url,attribution_text,attribution_url,
      terms_url,share_alike,notice_required,redistribution_allowed,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...sourceValues).run();
    const dataset = (id: string, version: string, status: string, accepted: number, active: number, importedAt: string) =>
      database.prepare(`INSERT INTO address_datasets(
        id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,format,
        license_code,license_name,license_url,attribution_text,attribution_url,terms_url,
        share_alike,notice_required,redistribution_allowed,accepted_count,active_count,status
      ) VALUES (?,'fixture-source','US',?,?,?,'${'a'.repeat(64)}','csv','CC0-1.0','CC0',
        'https://license.example','','','',0,0,1,?,?,?)`)
        .bind(id, version, importedAt, importedAt, accepted, active, status);
    await database.batch([
      dataset('active-dataset', '2026-08', 'active', 12, 10, '2026-08-01T00:00:00.000Z'),
      dataset('retired-dataset', '2026-07', 'retired', 8, 8, '2026-07-01T00:00:00.000Z')
    ]);
    const countries = await listAddressData(database);
    const unitedStates = countries.find((country) => country.countryCode === 'US');
    expect(unitedStates?.sources).toContainEqual(expect.objectContaining({
      id: 'fixture-source',
      activeDatasetCount: 1,
      acceptedCount: 20,
      activeCount: 10,
      latestVersion: '2026-08'
    }));
    expect(countries.find((country) => country.countryCode === 'CN')?.sources.map((source) => source.id))
      .toEqual(expect.arrayContaining(['amap', 'baidu', 'tencent']));
    expect(JSON.stringify(unitedStates)).not.toContain('apiKey');
  });
});
