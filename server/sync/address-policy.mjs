const DEFAULT_PREPARE_CONCURRENCY = 10;
const DEFAULT_CPU_CONCURRENCY = 3;

const policy = (target, limits, labels) => ({ target, limits, labels });

export const ADDRESS_POLICY_DEFAULTS = {
  US: policy(50_000, [2_000, 300, 80, 0], ['State', 'County / city', 'Local area', '']),
  CA: policy(35_000, [2_500, 350, 80, 0], ['Province / territory', 'City', 'Regional area', '']),
  MX: policy(30_000, [2_000, 300, 70, 0], ['State', 'Municipality', 'Locality', '']),
  GB: policy(35_000, [3_000, 350, 80, 0], ['Country / region', 'Post town', 'District', '']),
  DE: policy(40_000, [2_500, 350, 80, 0], ['State', 'Municipality', 'District', '']),
  FR: policy(40_000, [3_500, 350, 80, 0], ['Region', 'Commune', 'District', '']),
  IT: policy(35_000, [2_500, 350, 80, 0], ['Region', 'Municipality', 'District', '']),
  ES: policy(35_000, [2_500, 350, 80, 0], ['Autonomous community', 'Municipality', 'District', '']),
  NL: policy(30_000, [3_000, 400, 80, 0], ['Province', 'Municipality', 'District', '']),
  JP: policy(40_000, [1_500, 200, 50, 0], ['Prefecture', 'Municipality', 'Town / ward', '']),
  CN: policy(40_000, [2_500, 400, 30, 10], ['Province', 'Prefecture city', 'District / county', 'Township']),
  HK: policy(12_000, [2_000, 300, 80, 0], ['Region', 'District', 'Locality', '']),
  TW: policy(25_000, [2_000, 300, 70, 0], ['County / city', 'District / township', 'Village', '']),
  KR: policy(20_000, [1_500, 250, 60, 0], ['Province / city', 'City / district', 'Neighborhood', '']),
  SG: policy(8_000, [8_000, 500, 80, 0], ['Planning region', 'Planning area', 'Locality', '']),
  MY: policy(15_000, [1_500, 250, 60, 0], ['State / territory', 'District / city', 'Locality', '']),
  TH: policy(15_000, [1_200, 250, 60, 0], ['Province', 'District', 'Subdistrict', '']),
  PH: policy(15_000, [2_500, 500, 150, 40], ['Region', 'Province', 'City / municipality', 'Barangay']),
  VN: policy(15_000, [1_200, 250, 60, 0], ['Province / municipality', 'District', 'Ward / commune', '']),
  TR: policy(15_000, [1_200, 250, 60, 0], ['Province', 'District', 'Neighborhood', '']),
  SA: policy(8_000, [1_000, 200, 50, 0], ['Region', 'City', 'District', '']),
  IN: policy(30_000, [1_800, 300, 70, 0], ['State / territory', 'District / city', 'Locality', '']),
  AU: policy(35_000, [4_000, 350, 80, 0], ['State / territory', 'Locality', 'District', '']),
  BR: policy(30_000, [1_500, 250, 60, 0], ['State', 'Municipality', 'District', '']),
  NG: policy(10_000, [1_000, 200, 50, 0], ['State', 'Local government area', 'Locality', '']),
  ZA: policy(15_000, [1_500, 250, 60, 0], ['Province', 'Municipality', 'Locality', '']),
  RU: policy(30_000, [2_000, 300, 70, 0], ['Federal subject', 'City / district', 'Locality', ''])
};

const integer = (value, minimum, maximum, code) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
};

export const validateCountryPolicy = (countryCode, input) => {
  const code = String(countryCode || '').trim().toUpperCase();
  const defaults = ADDRESS_POLICY_DEFAULTS[code];
  if (!defaults) throw new Error('INVALID_POLICY_COUNTRY');
  const limits = [1, 2, 3, 4].map((level, index) => integer(
    input[`level${level}Limit`] ?? input.limits?.[index] ?? defaults.limits[index], 0, 1_000_000, 'INVALID_POLICY_LIMIT'
  ));
  return {
    countryCode: code,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    targetCount: integer(input.targetCount ?? defaults.target, 1, 2_000_000, 'INVALID_POLICY_TARGET'),
    limits
  };
};

export const validateRuntimePolicy = (input) => ({
  prepareConcurrency: integer(input.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY, 1, 10, 'INVALID_PREPARE_CONCURRENCY'),
  cpuConcurrency: integer(input.cpuConcurrency ?? DEFAULT_CPU_CONCURRENCY, 1, 4, 'INVALID_CPU_CONCURRENCY')
});

export const ensureAddressPolicies = async (database, now = new Date().toISOString()) => {
  const statements = Object.entries(ADDRESS_POLICY_DEFAULTS).map(([countryCode, value]) => database.prepare(`
    INSERT OR IGNORE INTO sync_country_policies(
      country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).bind(countryCode, 1, value.target, ...value.limits, now));
  statements.push(database.prepare(`INSERT OR IGNORE INTO sync_runtime_settings(
    id,prepare_concurrency,cpu_concurrency,updated_at
  ) VALUES (1,?,?,?)`).bind(DEFAULT_PREPARE_CONCURRENCY, DEFAULT_CPU_CONCURRENCY, now));
  await database.batch(statements);
};

const rowPolicy = (row) => ({
  countryCode: String(row.country_code), enabled: Boolean(row.enabled), targetCount: Number(row.target_count),
  level1Limit: Number(row.level1_limit), level2Limit: Number(row.level2_limit),
  level3Limit: Number(row.level3_limit), level4Limit: Number(row.level4_limit), updatedAt: String(row.updated_at)
});

export const getRuntimePolicy = async (database) => {
  await ensureAddressPolicies(database);
  const row = await database.prepare('SELECT prepare_concurrency,cpu_concurrency,updated_at FROM sync_runtime_settings WHERE id=1').first();
  return { prepareConcurrency: Number(row.prepare_concurrency), cpuConcurrency: Number(row.cpu_concurrency), updatedAt: String(row.updated_at) };
};

export const updateRuntimePolicy = async (database, input) => {
  const value = validateRuntimePolicy(input);
  const now = new Date().toISOString();
  await database.prepare(`UPDATE sync_runtime_settings SET prepare_concurrency=?,cpu_concurrency=?,updated_at=? WHERE id=1`)
    .bind(value.prepareConcurrency, value.cpuConcurrency, now).run();
  return { ...value, updatedAt: now };
};

export const listCountryPolicies = async (database) => {
  await ensureAddressPolicies(database);
  const rows = (await database.prepare(`SELECT policy.*,
    COALESCE((SELECT total_count FROM admin_coverage_stats coverage WHERE coverage.node_key=policy.country_code),0) AS actual_count,
    (SELECT version FROM address_datasets dataset WHERE dataset.country_code=policy.country_code AND dataset.status='active'
      ORDER BY imported_at DESC LIMIT 1) AS source_version
    FROM sync_country_policies policy ORDER BY policy.country_code`).all()).results;
  return rows.map((row) => {
    const currentCount = Number(row.actual_count || 0);
    const targetCount = Number(row.target_count);
    return {
      ...rowPolicy(row), currentCount, sourceVersion: row.source_version ? String(row.source_version) : null,
      deficit: Math.max(0, targetCount - currentCount), excess: Math.max(0, currentCount - targetCount),
      state: currentCount > targetCount ? 'excess' : currentCount < targetCount ? 'deficit' : 'ready',
      labels: ADDRESS_POLICY_DEFAULTS[String(row.country_code)]?.labels || []
    };
  });
};

export const getCountryPolicy = async (database, countryCode) => {
  await ensureAddressPolicies(database);
  const code = String(countryCode || '').trim().toUpperCase();
  const row = await database.prepare('SELECT * FROM sync_country_policies WHERE country_code=?').bind(code).first();
  if (!row) throw new Error('POLICY_NOT_FOUND');
  return { ...rowPolicy(row), labels: ADDRESS_POLICY_DEFAULTS[code].labels };
};

export const updateCountryPolicy = async (database, countryCode, input) => {
  const value = validateCountryPolicy(countryCode, input);
  const now = new Date().toISOString();
  await ensureAddressPolicies(database, now);
  await database.prepare(`UPDATE sync_country_policies SET enabled=?,target_count=?,level1_limit=?,level2_limit=?,
    level3_limit=?,level4_limit=?,updated_at=? WHERE country_code=?`).bind(
    Number(value.enabled), value.targetCount, ...value.limits, now, value.countryCode
  ).run();
  return getCountryPolicy(database, value.countryCode);
};

export const listNodePolicies = async (database, parentKey) => {
  const parent = String(parentKey || '');
  const rows = (await database.prepare(`SELECT coverage.node_key,coverage.parent_key,coverage.country_code,coverage.level,
    coverage.region_code,coverage.region_name,coverage.total_count,coverage.child_count,coverage.updated_at,
    override.target_count AS override_target,
    CASE coverage.level WHEN 1 THEN country.level1_limit WHEN 2 THEN country.level2_limit
      WHEN 3 THEN country.level3_limit WHEN 4 THEN country.level4_limit ELSE country.target_count END AS inherited_target
    FROM admin_coverage_stats coverage JOIN sync_country_policies country ON country.country_code=coverage.country_code
    LEFT JOIN sync_node_overrides override ON override.node_key=coverage.node_key
    WHERE coverage.parent_key=? ORDER BY coverage.total_count DESC,coverage.region_name`).bind(parent).all()).results;
  return rows.map((row) => {
    const inheritedTarget = Number(row.inherited_target || 0);
    const overrideTarget = row.override_target == null ? null : Number(row.override_target);
    const targetCount = overrideTarget ?? inheritedTarget;
    const currentCount = Number(row.total_count || 0);
    const bounded = overrideTarget !== null || inheritedTarget > 0;
    return {
      key: String(row.node_key), parentKey: String(row.parent_key), countryCode: String(row.country_code),
      level: Number(row.level), regionCode: String(row.region_code || ''), regionName: String(row.region_name),
      currentCount, childCount: Number(row.child_count || 0), inheritedTarget, overrideTarget, targetCount,
      deficit: bounded ? Math.max(0, targetCount - currentCount) : 0,
      excess: bounded ? Math.max(0, currentCount - targetCount) : 0,
      updatedAt: String(row.updated_at)
    };
  });
};

export const upsertNodePolicy = async (database, nodeKey, targetCount) => {
  const key = String(nodeKey || '');
  const target = integer(targetCount, 0, 1_000_000, 'INVALID_POLICY_TARGET');
  const node = await database.prepare('SELECT country_code,level FROM admin_coverage_stats WHERE node_key=?').bind(key).first();
  if (!node || Number(node.level) < 1) throw new Error('POLICY_NODE_NOT_FOUND');
  const now = new Date().toISOString();
  await database.prepare(`INSERT INTO sync_node_overrides(node_key,country_code,level,target_count,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(node_key) DO UPDATE SET target_count=excluded.target_count,updated_at=excluded.updated_at`)
    .bind(key, String(node.country_code), Number(node.level), target, now).run();
  return { key, targetCount: target, updatedAt: now };
};

export const deleteNodePolicy = async (database, nodeKey) => {
  await database.prepare('DELETE FROM sync_node_overrides WHERE node_key=?').bind(String(nodeKey || '')).run();
};

export const loadImportPolicy = async (database, countryCode, fallbackMaxRecords, fallbackPerLocality) => {
  await ensureAddressPolicies(database);
  const country = await getCountryPolicy(database, countryCode).catch(() => null);
  if (!country) return {
    enabled: true,
    targetCount: fallbackMaxRecords,
    levelLimits: [fallbackMaxRecords, fallbackPerLocality, fallbackPerLocality, fallbackPerLocality],
    overrides: new Map()
  };
  if (!country.enabled) return {
    enabled: false,
    targetCount: country.targetCount,
    levelLimits: [country.level1Limit, country.level2Limit, country.level3Limit, country.level4Limit],
    overrides: new Map()
  };
  const overrides = (await database.prepare('SELECT node_key,target_count FROM sync_node_overrides WHERE country_code=?')
    .bind(countryCode).all()).results;
  return {
    enabled: true,
    targetCount: country.targetCount,
    levelLimits: [country.level1Limit, country.level2Limit, country.level3Limit, country.level4Limit],
    overrides: new Map(overrides.map((row) => [String(row.node_key), Number(row.target_count)]))
  };
};

export const policyNodeKeys = (record) => {
  const hex = (value) => Buffer.from(String(value || ''), 'utf8').toString('hex').toUpperCase();
  const country = record.countryCode;
  const admin1 = String(record.components?.admin1 || record.admin1 || '').trim();
  const locality = String(record.components?.locality || record.components?.postalLocality || record.locality || '').trim();
  const district = String(record.components?.district || record.district || '').trim();
  const level1 = admin1 ? `${country}:a1:${hex(admin1)}` : '';
  const level2 = admin1 && locality ? `${country}:loc:${hex(admin1)}:${hex(locality)}` : '';
  const level3 = admin1 && locality && district ? `${country}:dist:${hex(admin1)}:${hex(locality)}:${hex(district)}` : '';
  return [level1, level2, level3, ''];
};

export const applyHierarchicalQuota = (records, policyValue) => {
  const counts = [new Map(), new Map(), new Map(), new Map()];
  const selected = [];
  for (const record of records) {
    if (selected.length >= policyValue.targetCount) break;
    const keys = policyNodeKeys(record);
    const accepted = keys.every((key, index) => {
      if (!key) return true;
      const overridden = policyValue.overrides.has(key);
      const limit = overridden ? policyValue.overrides.get(key) : policyValue.levelLimits[index];
      return (!overridden && limit === 0) || (counts[index].get(key) || 0) < limit;
    });
    if (!accepted) continue;
    selected.push(record);
    keys.forEach((key, index) => { if (key) counts[index].set(key, (counts[index].get(key) || 0) + 1); });
  }
  return selected;
};
