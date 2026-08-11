const mainlandProvincePrefixes = new Set([
  '11', '12', '13', '14', '15', '21', '22', '23', '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46', '50', '51', '52', '53', '54', '61', '62', '63', '64', '65'
]);

export const eligibleCoverageNode = (row) => row.country_code !== 'CN'
  || mainlandProvincePrefixes.has(String(row.region_code || '').slice(0, 2));

const ratio = (satisfied, total) => total > 0 ? satisfied / total : null;

const catalogCoverageSummaries = async (database) => {
  const [regionsResult, coverageResult, cityResult, policiesResult] = await Promise.all([
    database.prepare('SELECT id,parent_id,country_code,code FROM catalog_regions').all(),
    database.prepare(`SELECT country_code,region_id,SUM(address_count) AS address_count
      FROM residential_coverage WHERE region_id IS NOT NULL
      GROUP BY country_code,region_id`).all(),
    database.prepare(`WITH city_counts AS (
        SELECT city_id,SUM(address_count) AS address_count
        FROM residential_coverage WHERE city_id IS NOT NULL GROUP BY city_id
      )
      SELECT city.country_code,city.region_id,COUNT(*) AS total,
        SUM(CASE WHEN COALESCE(coverage.address_count,0)>0 THEN 1 ELSE 0 END) AS covered,
        SUM(CASE WHEN COALESCE(coverage.address_count,0)>=policy.min_per_node THEN 1 ELSE 0 END) AS qualified_lowest,
        SUM(CASE WHEN COALESCE(coverage.address_count,0)>=policy.level1_min THEN 1 ELSE 0 END) AS qualified_level1,
        SUM(CASE WHEN COALESCE(coverage.address_count,0)>=policy.level2_min THEN 1 ELSE 0 END) AS qualified_level2
      FROM catalog_cities city
      JOIN sync_country_policies policy ON policy.country_code=city.country_code
      LEFT JOIN city_counts coverage ON coverage.city_id=city.id
      GROUP BY city.country_code,city.region_id`).all(),
    database.prepare(`SELECT country_code,min_per_node,level1_min,level2_min
      FROM sync_country_policies`).all()
  ]);
  const regions = regionsResult.results || [];
  const byId = new Map(regions.map((region) => [Number(region.id), region]));
  const policies = new Map((policiesResult.results || []).map((policy) => [String(policy.country_code), policy]));
  const depthById = new Map();
  const regionDepth = (region) => {
    const id = Number(region.id);
    if (depthById.has(id)) return depthById.get(id);
    const seen = new Set([id]);
    let depth = 1;
    let parent = region.parent_id == null ? null : byId.get(Number(region.parent_id));
    while (parent && !seen.has(Number(parent.id))) {
      seen.add(Number(parent.id));
      depth += 1;
      parent = parent.parent_id == null ? null : byId.get(Number(parent.parent_id));
    }
    depthById.set(id, depth);
    return depth;
  };
  const regionCounts = new Map();
  for (const row of coverageResult.results || []) {
    const count = Number(row.address_count || 0);
    let region = byId.get(Number(row.region_id));
    const seen = new Set();
    while (region && !seen.has(Number(region.id))) {
      const id = Number(region.id);
      seen.add(id);
      regionCounts.set(id, (regionCounts.get(id) || 0) + count);
      region = region.parent_id == null ? null : byId.get(Number(region.parent_id));
    }
  }
  const summaries = new Map();
  const summary = (countryCode, level) => {
    const country = summaries.get(countryCode) || new Map();
    const value = country.get(level) || {
      level, total: 0, covered: 0, qualified_lowest: 0, qualified_level1: 0, qualified_level2: 0
    };
    country.set(level, value);
    summaries.set(countryCode, country);
    return value;
  };
  for (const region of regions) {
    const countryCode = String(region.country_code);
    const policy = policies.get(countryCode);
    if (!policy) continue;
    const count = regionCounts.get(Number(region.id)) || 0;
    const value = summary(countryCode, regionDepth(region));
    value.total += 1;
    if (count > 0) value.covered += 1;
    if (count >= Number(policy.min_per_node || 0)) value.qualified_lowest += 1;
    if (count >= Number(policy.level1_min || 0)) value.qualified_level1 += 1;
    if (count >= Number(policy.level2_min || 0)) value.qualified_level2 += 1;
  }
  for (const row of cityResult.results || []) {
    const region = byId.get(Number(row.region_id));
    const value = summary(String(row.country_code), Math.max(2, region ? regionDepth(region) + 1 : 1));
    for (const key of ['total', 'covered', 'qualified_lowest', 'qualified_level1', 'qualified_level2']) {
      value[key] += Number(row[key] || 0);
    }
  }
  return new Map([...summaries].map(([countryCode, levels]) => [countryCode, [...levels.values()]]));
};

export const evaluateCountryGoals = async (database) => {
  const [policiesResult, coverageResult, overridesResult, catalogSummaries] = await Promise.all([
    database.prepare(`SELECT policy.country_code,policy.enabled,policy.target_count,policy.min_per_node,
        policy.coverage_ratio,policy.level1_min,policy.level2_min,
        CASE WHEN COALESCE(root.residential_count,0)=0 AND COALESCE(state.residential_count,0)>0
          THEN state.residential_count ELSE COALESCE(root.residential_count,0) END AS current_count
      FROM sync_country_policies policy
      LEFT JOIN admin_coverage_stats root ON root.node_key=policy.country_code AND root.level=0
      LEFT JOIN sync_country_state state ON state.country_code=policy.country_code
      ORDER BY policy.country_code`).all(),
    database.prepare(`SELECT coverage.country_code,coverage.level,coverage.region_code,coverage.residential_count,
        override.min_count AS override_target
      FROM admin_coverage_stats coverage
      LEFT JOIN sync_node_overrides override ON override.node_key=coverage.node_key
      WHERE coverage.level>0
      ORDER BY coverage.country_code,coverage.level`).all(),
    database.prepare(`SELECT override.country_code,coverage.level,coverage.region_code,coverage.residential_count,
        override.min_count AS target_count
      FROM sync_node_overrides override
      JOIN admin_coverage_stats coverage ON coverage.node_key=override.node_key
      WHERE override.min_count IS NOT NULL AND override.min_count>0`).all(),
    catalogCoverageSummaries(database)
  ]);
  const nodesByCountry = new Map();
  for (const row of coverageResult.results.filter(eligibleCoverageNode)) {
    const nodes = nodesByCountry.get(row.country_code) || [];
    nodes.push(row);
    nodesByCountry.set(row.country_code, nodes);
  }
  const overridesByCountry = new Map();
  for (const row of overridesResult.results.filter(eligibleCoverageNode)) {
    const nodes = overridesByCountry.get(row.country_code) || [];
    nodes.push(row);
    overridesByCountry.set(row.country_code, nodes);
  }
  const goals = new Map();
  for (const policy of policiesResult.results) {
    const countryCode = String(policy.country_code);
    const catalog = countryCode === 'CN' ? [] : catalogSummaries.get(countryCode) || [];
    const nodes = catalog.length ? [] : nodesByCountry.get(countryCode) || [];
    const lowestLevel = (catalog.length ? catalog : nodes)
      .reduce((maximum, node) => Math.max(maximum, Number(node.level)), 0);
    const levelNodes = (level) => nodes.filter((node) => Number(node.level) === level);
    const nodeTarget = (node, fallback) => node.override_target == null ? fallback : Number(node.override_target);
    const summarize = (level, fallback, catalogQualified) => {
      const catalogLevel = catalog.find((value) => Number(value.level) === level);
      if (catalogLevel) {
        const total = Number(catalogLevel.total || 0);
        const covered = Number(catalogLevel.covered || 0);
        const qualified = Number(catalogLevel[catalogQualified] || 0);
        return {
          level, minimum: fallback, total, covered, qualified,
          coverageRatio: ratio(covered, total), floorRatio: ratio(qualified, total)
        };
      }
      const values = levelNodes(level);
      if (!values.length) return null;
      const covered = values.filter((node) => Number(node.residential_count || 0) > 0).length;
      const qualified = values.filter((node) => {
        const target = nodeTarget(node, fallback);
        return target <= 0 || Number(node.residential_count || 0) >= target;
      }).length;
      return {
        level, minimum: fallback, total: values.length, covered, qualified,
        coverageRatio: ratio(covered, values.length), floorRatio: ratio(qualified, values.length)
      };
    };
    const lowest = lowestLevel ? summarize(lowestLevel, Number(policy.min_per_node || 0), 'qualified_lowest') : null;
    const level1 = summarize(1, Number(policy.level1_min || 0), 'qualified_level1');
    const level2 = summarize(2, Number(policy.level2_min || 0), 'qualified_level2');
    const targetRatio = Number(policy.coverage_ratio ?? 1);
    const administrativeCoverageActual = lowest?.coverageRatio ?? 0;
    const floorRatios = [
      lowest?.floorRatio ?? 0,
      Number(policy.level1_min || 0) > 0 ? level1?.floorRatio ?? 0 : null,
      Number(policy.level2_min || 0) > 0 ? level2?.floorRatio ?? 0 : null
    ]
      .filter((value) => value !== null && value !== undefined);
    const regionalMinimumActual = floorRatios.length ? Math.min(...floorRatios) : 1;
    const administrativeCoverageMet = administrativeCoverageActual >= targetRatio;
    const regionalMinimumMet = regionalMinimumActual >= targetRatio;
    const coverageActual = Math.min(administrativeCoverageActual, regionalMinimumActual);
    const overrideNodes = overridesByCountry.get(countryCode) || [];
    const overrideSatisfied = overrideNodes.filter((node) => Number(node.residential_count || 0) >= Number(node.target_count)).length;
    const overrideMet = overrideSatisfied === overrideNodes.length;
    const current = Number(policy.current_count || 0);
    const target = Number(policy.target_count || 0);
    const countMet = current >= target;
    const coverageMet = administrativeCoverageMet && regionalMinimumMet;
    const complete = Boolean(policy.enabled) && countMet && coverageMet && overrideMet;
    const unmetRules = [];
    if (!countMet) unmetRules.push('total');
    if (!administrativeCoverageMet) unmetRules.push('administrative_coverage');
    if (!regionalMinimumMet || !overrideMet) unmetRules.push('regional_minimums');
    goals.set(countryCode, {
      countryCode, enabled: Boolean(policy.enabled), current, target, deficit: Math.max(0, target - current),
      countMet, coverageMet, overrideMet, complete, unmetRules, coverageRatio: targetRatio, coverageActual,
      lowest, level1, level2,
      rules: {
        total: { current, target, met: countMet },
        administrativeCoverage: {
          actual: administrativeCoverageActual, target: targetRatio, met: administrativeCoverageMet,
          covered: lowest?.covered ?? 0, total: lowest?.total ?? 0
        },
        regionalMinimums: {
          actual: regionalMinimumActual, target: targetRatio,
          met: regionalMinimumMet && overrideMet,
          lowest,
          level1: Number(policy.level1_min || 0) > 0 ? level1 : null,
          level2: Number(policy.level2_min || 0) > 0 ? level2 : null,
          overrides: { satisfied: overrideSatisfied, total: overrideNodes.length, met: overrideMet }
        }
      }
    });
  }
  return goals;
};
