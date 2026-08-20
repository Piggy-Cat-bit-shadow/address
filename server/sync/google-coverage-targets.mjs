const finitePoint = (value) => {
  if (value?.latitude == null || value?.longitude == null
    || value.latitude === '' || value.longitude === '') return null;
  const latitude = Number(value?.latitude);
  const longitude = Number(value?.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
};

const regionDepths = (regions) => {
  const byId = new Map(regions.map((region) => [Number(region.id), region]));
  const depths = new Map();
  const depth = (region) => {
    const id = Number(region.id);
    if (depths.has(id)) return depths.get(id);
    const seen = new Set([id]);
    let value = 1;
    let parent = region.parent_id == null ? null : byId.get(Number(region.parent_id));
    while (parent && !seen.has(Number(parent.id))) {
      seen.add(Number(parent.id));
      value += 1;
      parent = parent.parent_id == null ? null : byId.get(Number(parent.parent_id));
    }
    depths.set(id, value);
    return value;
  };
  for (const region of regions) depth(region);
  return { byId, depths };
};

export const buildGoogleCoverageTargets = ({ policy, regions = [], cities = [], coverage = [], overrides = [] }) => {
  if (!policy) return [];
  const { byId, depths } = regionDepths(regions);
  const cityCounts = new Map();
  const directRegionCounts = new Map();
  for (const row of coverage) {
    const count = Number(row.address_count || 0);
    if (row.city_id != null) cityCounts.set(Number(row.city_id), (cityCounts.get(Number(row.city_id)) || 0) + count);
    if (row.region_id != null) directRegionCounts.set(Number(row.region_id), (directRegionCounts.get(Number(row.region_id)) || 0) + count);
  }
  const regionCounts = new Map();
  for (const [regionId, count] of directRegionCounts) {
    let region = byId.get(regionId);
    const seen = new Set();
    while (region && !seen.has(Number(region.id))) {
      const id = Number(region.id);
      seen.add(id);
      regionCounts.set(id, (regionCounts.get(id) || 0) + count);
      region = region.parent_id == null ? null : byId.get(Number(region.parent_id));
    }
  }
  const targets = new Map();
  const add = (id, kind, value, count, minimum, priority) => {
    const point = finitePoint(value);
    const target = Number(minimum || 0);
    if (!point || target <= 0 || count >= target) return;
    const current = targets.get(id);
    const candidate = {
      id,
      kind,
      priority,
      deficit: target - count,
      ...point,
      regionId: kind === 'region' ? Number(value.id) : Number(value.region_id),
      cityId: kind === 'city' ? Number(value.id) : null
    };
    if (!current || candidate.priority < current.priority || candidate.deficit > current.deficit) targets.set(id, candidate);
  };
  const minimumPerNode = Number(policy.min_per_node || 0);
  for (const city of cities) {
    const count = cityCounts.get(Number(city.id)) || 0;
    add(`city:${city.id}`, 'city', city, count, minimumPerNode, count === 0 ? 0 : 1);
  }
  for (const region of regions) {
    const level = depths.get(Number(region.id)) || 0;
    const count = regionCounts.get(Number(region.id)) || 0;
    const minimum = Math.max(
      level === 1 ? Number(policy.level1_min || 0) : 0,
      level === 2 ? Number(policy.level2_min || 0) : 0
    );
    add(`region:${region.id}`, 'region', region, count, minimum, 2);
  }
  const regionsByCode = new Map(regions.filter((region) => String(region.code || '')).map((region) => [String(region.code), region]));
  const citiesByName = new Map();
  for (const city of cities) {
    for (const name of [city.name, city.native_name, city.zh_name]
      .filter((value) => value != null && value !== '').map(String)) {
      const values = citiesByName.get(name) || [];
      if (!values.some((value) => Number(value.id) === Number(city.id))) values.push(city);
      citiesByName.set(name, values);
    }
  }
  for (const override of overrides) {
    const minimum = Number(override.min_count || 0);
    const count = Number(override.residential_count || 0);
    if (minimum <= count) continue;
    const region = regionsByCode.get(String(override.region_code || ''));
    if (region) add(`region:${region.id}`, 'region', region, count, minimum, 2);
    else {
      const matches = citiesByName.get(String(override.region_name || '')) || [];
      if (matches.length === 1) add(`city:${matches[0].id}`, 'city', matches[0], count, minimum, count === 0 ? 0 : 1);
    }
  }
  return [...targets.values()].sort((left, right) => left.priority - right.priority
    || right.deficit - left.deficit || left.id.localeCompare(right.id));
};

export const loadGoogleCoverageTargets = async (database, countryCode) => {
  const [policy, regions, cities, coverage, overrides] = await Promise.all([
    database.prepare(`SELECT min_per_node,level1_min,level2_min FROM sync_country_policies
      WHERE country_code=? AND enabled=1`).bind(countryCode).first(),
    database.prepare(`SELECT id,parent_id,code,name,native_name,zh_name,latitude,longitude FROM catalog_regions
      WHERE country_code=?`).bind(countryCode).all(),
    database.prepare(`SELECT id,region_id,name,native_name,zh_name,latitude,longitude FROM catalog_cities
      WHERE country_code=?`).bind(countryCode).all(),
    database.prepare(`SELECT region_id,city_id,SUM(address_count) AS address_count FROM residential_coverage
      WHERE country_code=? GROUP BY region_id,city_id`).bind(countryCode).all(),
    database.prepare(`SELECT stats.region_code,stats.region_name,stats.residential_count,override.min_count
      FROM sync_node_overrides override JOIN admin_coverage_stats stats ON stats.node_key=override.node_key
      WHERE override.country_code=? AND override.min_count>stats.residential_count`).bind(countryCode).all()
  ]);
  return buildGoogleCoverageTargets({
    policy,
    regions: regions.results || [],
    cities: cities.results || [],
    coverage: coverage.results || [],
    overrides: overrides.results || []
  });
};
