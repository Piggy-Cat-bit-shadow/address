import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/database/sqlite.mjs';
import {
  ADDRESS_POLICY_DEFAULTS, applyHierarchicalQuota, ensureAddressPolicies, getRuntimePolicy,
  listCountryPolicies, listNodePolicies, updateCountryPolicy, updateRuntimePolicy, upsertNodePolicy
} from '../server/sync/address-policy.mjs';
import { mapConcurrent } from '../server/sync/address-etl.mjs';

const record = (hash, admin1, locality, district = '') => ({
  canonicalHash: hash, countryCode: 'US', qualityScore: 0.9,
  components: { admin1, locality, district }
});

describe('hierarchical address policies', () => {
  it('seeds all supported countries and validates runtime concurrency', async () => {
    const database = openDatabase(':memory:');
    await ensureAddressPolicies(database, '2026-07-28T00:00:00.000Z');
    expect((await listCountryPolicies(database))).toHaveLength(Object.keys(ADDRESS_POLICY_DEFAULTS).length);
    await expect(updateRuntimePolicy(database, { prepareConcurrency: 11, cpuConcurrency: 2 }))
      .rejects.toThrow('INVALID_PREPARE_CONCURRENCY');
    expect(await updateRuntimePolicy(database, { prepareConcurrency: 10, cpuConcurrency: 4 }))
      .toMatchObject({ prepareConcurrency: 10, cpuConcurrency: 4 });
    expect(await getRuntimePolicy(database)).toMatchObject({ prepareConcurrency: 10, cpuConcurrency: 4 });
    database.close();
  });

  it('enforces country, hierarchy and node override limits without synthesizing shortages', () => {
    const records = [
      record('a', 'New York', 'New York', 'Manhattan'),
      record('b', 'New York', 'New York', 'Manhattan'),
      record('c', 'New York', 'Buffalo'),
      record('d', 'California', 'Los Angeles')
    ];
    const policy = { targetCount: 4, levelLimits: [3, 2, 1, 0], overrides: new Map() };
    expect(applyHierarchicalQuota(records, policy).map((value) => value.canonicalHash)).toEqual(['a', 'c', 'd']);
    const nodeKey = 'US:a1:4E657720596F726B';
    expect(applyHierarchicalQuota(records, { ...policy, overrides: new Map([[nodeKey, 1]]) })
      .map((value) => value.canonicalHash)).toEqual(['a', 'd']);
  });

  it('stores country settings and inherited node overrides separately from coverage counts', async () => {
    const database = openDatabase(':memory:');
    await ensureAddressPolicies(database);
    await database.prepare(`INSERT INTO admin_coverage_stats(
      node_key,parent_key,country_code,level,region_name,total_count,updated_at
    ) VALUES ('US:a1:AA','US','US',1,'Fixture State',12,'2026-07-28T00:00:00Z')`).run();
    await updateCountryPolicy(database, 'US', { targetCount: 100, level1Limit: 20, level2Limit: 5, level3Limit: 2, level4Limit: 0 });
    expect((await listNodePolicies(database, 'US'))[0]).toMatchObject({ inheritedTarget: 20, targetCount: 20, currentCount: 12 });
    await upsertNodePolicy(database, 'US:a1:AA', 7);
    expect((await listNodePolicies(database, 'US'))[0]).toMatchObject({ overrideTarget: 7, targetCount: 7, excess: 5 });
    database.close();
  });

  it('bounds concurrent preparation while preserving result order', async () => {
    let active = 0;
    let maximum = 0;
    const output = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      return value * 2;
    });
    expect(output).toEqual([2, 4, 6, 8, 10]);
    expect(maximum).toBe(2);
  });
});
