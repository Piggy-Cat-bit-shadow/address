import { describe, expect, it } from 'vitest';
import {
  buildGoogleCoverageTargets, loadGoogleCoverageTargets
} from '../server/sync/google-coverage-targets.mjs';

const policy = { min_per_node: 5, level1_min: 10, level2_min: 8 };
const regions = [
  { id: 1, parent_id: null, code: 'A', name: 'Alpha', latitude: 10, longitude: 10 },
  { id: 11, parent_id: 1, code: 'A1', name: 'Alpha One', latitude: 11, longitude: 11 },
  { id: 2, parent_id: null, code: 'B', name: 'Beta', latitude: 20, longitude: 20 },
  { id: 21, parent_id: 2, code: 'B1', name: 'Beta One', latitude: 21, longitude: 21 }
];
const cities = [
  { id: 101, region_id: 11, name: 'Empty City', latitude: 11.1, longitude: 11.1 },
  { id: 102, region_id: 11, name: 'Low City', latitude: 11.2, longitude: 11.2 },
  { id: 201, region_id: 21, name: 'Ready City', latitude: 21.1, longitude: 21.1 }
];
const coverage = [
  { region_id: 11, city_id: 102, address_count: 2 },
  { region_id: 21, city_id: 201, address_count: 20 }
];

describe('Google administrative coverage targets', () => {
  it('orders zero-coverage cities before under-floor cities and parent region gaps', () => {
    expect(buildGoogleCoverageTargets({ policy, regions, cities, coverage })).toEqual([
      { id: 'city:101', kind: 'city', priority: 0, deficit: 5, latitude: 11.1, longitude: 11.1, regionId: 11, cityId: 101 },
      { id: 'city:102', kind: 'city', priority: 1, deficit: 3, latitude: 11.2, longitude: 11.2, regionId: 11, cityId: 102 },
      { id: 'region:1', kind: 'region', priority: 2, deficit: 8, latitude: 10, longitude: 10, regionId: 1, cityId: null },
      { id: 'region:11', kind: 'region', priority: 2, deficit: 6, latitude: 11, longitude: 11, regionId: 11, cityId: null }
    ]);
  });

  it('uses exact official codes or an unambiguous catalog name for custom node targets', () => {
    const targets = buildGoogleCoverageTargets({
      policy: { min_per_node: 0, level1_min: 0, level2_min: 0 }, regions, cities, coverage,
      overrides: [
        { region_code: 'B', region_name: '', residential_count: 20, min_count: 25 },
        { region_code: '', region_name: 'Ready City', residential_count: 20, min_count: 22 }
      ]
    });
    expect(targets).toEqual([
      { id: 'city:201', kind: 'city', priority: 1, deficit: 2, latitude: 21.1, longitude: 21.1, regionId: 21, cityId: 201 },
      { id: 'region:2', kind: 'region', priority: 2, deficit: 5, latitude: 20, longitude: 20, regionId: 2, cityId: null }
    ]);
  });

  it('gracefully ignores missing policy, missing coordinates and ambiguous names', () => {
    expect(buildGoogleCoverageTargets({ policy: null, regions, cities, coverage })).toEqual([]);
    expect(buildGoogleCoverageTargets({
      policy,
      regions: [{ ...regions[0], latitude: null }],
      cities: [
        { id: 1, region_id: 1, name: 'Same', latitude: null, longitude: 1 },
        { id: 2, region_id: 1, name: 'Same', latitude: 1, longitude: null }
      ],
      coverage: [],
      overrides: [{ region_name: 'Same', residential_count: 0, min_count: 5 }]
    })).toEqual([]);
  });

  it('loads one stable target plan from the catalog and current coverage tables', async () => {
    const rows = new Map([
      ['sync_country_policies', policy],
      ['catalog_regions', { results: regions }],
      ['catalog_cities', { results: cities }],
      ['residential_coverage', { results: coverage }],
      ['sync_node_overrides', { results: [] }]
    ]);
    const database = {
      prepare(sql) {
        const key = [...rows.keys()].find((name) => sql.includes(name));
        return {
          bind(value) {
            expect(value).toBe('ZZ');
            return {
              first: async () => rows.get(key),
              all: async () => rows.get(key)
            };
          }
        };
      }
    };
    await expect(loadGoogleCoverageTargets(database, 'ZZ')).resolves.toEqual(
      buildGoogleCoverageTargets({ policy, regions, cities, coverage })
    );
  });

  it('targets catalog cities on every leaf branch regardless of hierarchy depth', () => {
    const targets = buildGoogleCoverageTargets({
      policy: { min_per_node: 5, level1_min: 0, level2_min: 0 },
      regions: [
        { id: 1, parent_id: null, code: 'A', name: 'A', latitude: 1, longitude: 1 },
        { id: 2, parent_id: 1, code: 'A2', name: 'A2', latitude: 2, longitude: 2 },
        { id: 3, parent_id: null, code: 'B', name: 'B', latitude: 3, longitude: 3 }
      ],
      cities: [
        { id: 11, region_id: 2, name: 'Deep', latitude: 2.1, longitude: 2.1 },
        { id: 12, region_id: 3, name: 'Shallow', latitude: 3.1, longitude: 3.1 }
      ],
      coverage: []
    });
    expect(targets.filter((target) => target.kind === 'city').map((target) => target.id))
      .toEqual(['city:11', 'city:12']);
  });

});
