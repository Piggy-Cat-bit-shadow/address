const mainlandProvincePrefixes = new Set([
  '11', '12', '13', '14', '15', '21', '22', '23', '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46', '50', '51', '52', '53', '54', '61', '62', '63', '64', '65'
]);

export const eligibleCoverageNode = (row) => row.country_code !== 'CN'
  || mainlandProvincePrefixes.has(String(row.region_code || '').slice(0, 2));

const ratio = (satisfied, total) => total > 0 ? satisfied / total : null;

export const evaluateCountryGoals = async (database) => {
  const [policiesResult, coverageResult, overridesResult] = await Promise.all([
    database.prepare(`SELECT policy.country_code,policy.enabled,policy.target_count,policy.min_per_node,
        policy.coverage_ratio,policy.level1_min,policy.level2_min,
        COALESCE(root.residential_count,0) AS current_count
      FROM sync_country_policies policy
      LEFT JOIN admin_coverage_stats root ON root.node_key=policy.country_code AND root.level=0
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
      WHERE override.min_count IS NOT NULL AND override.min_count>0`).all()
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
    const nodes = nodesByCountry.get(countryCode) || [];
    const lowestLevel = nodes.reduce((maximum, node) => Math.max(maximum, Number(node.level)), 0);
    const levelNodes = (level) => nodes.filter((node) => Number(node.level) === level);
    const nodeTarget = (node, fallback) => node.override_target == null ? fallback : Number(node.override_target);
    const summarize = (level, fallback) => {
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
    const lowest = lowestLevel ? summarize(lowestLevel, Number(policy.min_per_node || 0)) : null;
    const level1 = summarize(1, Number(policy.level1_min || 0));
    const level2 = summarize(2, Number(policy.level2_min || 0));
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
    if (!coverageMet) unmetRules.push('coverage');
    if (!overrideMet) unmetRules.push('node_overrides');
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
