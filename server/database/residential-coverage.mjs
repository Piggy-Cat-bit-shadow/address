import { addressQualitySqlClause } from '../../src/domain/address-quality.mjs';

const normalize = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/gu, '')
  .toLocaleLowerCase('und')
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .trim();

const aliases = (...values) => [...new Set(values.flatMap((value) => {
  const normalized = normalize(value);
  if (!normalized) return [];
  return [
    normalized,
    normalized.replace(/^(?:cityof)/u, '').replace(/(?:city|province|prefecture|region|state)$/u, '')
  ].filter(Boolean);
}))];

const addAlias = (map, key, value) => {
  if (!key) return;
  const values = map.get(key) || [];
  if (!values.some((item) => item.id === value.id)) values.push(value);
  map.set(key, values);
};

const evidenceClause = (type) => `address.id IN (
  SELECT evidence.address_id FROM address_pool_evidence evidence
  JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
    AND dataset.status='active' AND dataset.redistribution_allowed=1
  JOIN address_sources source ON source.id=dataset.source_id AND source.redistribution_allowed=1
  WHERE evidence.evidence_type='${type}' AND evidence.is_current=1
)`;

const regionRelated = (left, right) => {
  if (!left || !right) return false;
  if (left.id === right.id) return true;
  const leftPath = `${left.path || ''}/`;
  const rightPath = `${right.path || ''}/`;
  return leftPath.startsWith(rightPath) || rightPath.startsWith(leftPath);
};

const chooseRegion = (row, byCode, byName) => {
  const code = normalize(row.admin1_code);
  if (code && byCode.has(code)) return byCode.get(code)[0];
  for (const key of aliases(row.admin1)) {
    if (byCode.has(key)) return byCode.get(key)[0];
    if (byName.has(key)) return byName.get(key)[0];
  }
  return null;
};

const chooseCity = (row, region, cityAliases, regionsById) => {
  const candidates = aliases(row.city_name).flatMap((key) => cityAliases.get(key) || []);
  const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
  const scoped = region
    ? unique.filter((candidate) => regionRelated(region, regionsById.get(candidate.region_id)))
    : unique;
  return (scoped.length ? scoped : unique).sort((left, right) => Number(right.population || 0) - Number(left.population || 0))[0] || null;
};

export const refreshResidentialCoverage = async (database, countryCode, now = new Date().toISOString(), signal) => {
  const checkpoint = () => signal?.throwIfAborted();
  checkpoint();
  const country = String(countryCode || '').trim().toUpperCase();
  const [regionsResult, citiesResult, groupsResult] = await Promise.all([
    database.prepare(`SELECT id,parent_id,code,name,native_name,zh_name,path FROM catalog_regions
      WHERE country_code=?`).bind(country).all(),
    database.prepare(`SELECT id,region_id,name,native_name,zh_name,population FROM catalog_cities
      WHERE country_code=?`).bind(country).all(),
    database.prepare(`SELECT address.admin1,address.admin1_code,
        COALESCE(NULLIF(address.postal_locality,''),address.locality) AS city_name,COUNT(*) AS address_count
      FROM address_pool address
      WHERE address.country_code=? AND address.active=1
        AND address.property_type IN ('residential','apartment') AND address.quality_score>=0.7
        AND ${addressQualitySqlClause('address.')}
        AND ${evidenceClause('address_existence')} AND ${evidenceClause('residential_use')}
      GROUP BY address.admin1,address.admin1_code,COALESCE(NULLIF(address.postal_locality,''),address.locality)`)
      .bind(country).all()
  ]);
  checkpoint();
  const regions = regionsResult.results || [];
  const cities = citiesResult.results || [];
  const groups = groupsResult.results || [];
  if (!regions.length) return {
    countryCode: country, groups: groups.length, mappedGroups: 0, matchedAddresses: 0,
    unmatchedAddresses: groups.reduce((total, row) => total + Number(row.address_count || 0), 0), skipped: true
  };
  const regionsById = new Map(regions.map((region) => [Number(region.id), region]));
  const regionsByCode = new Map();
  const regionsByName = new Map();
  for (const region of regions) {
    checkpoint();
    addAlias(regionsByCode, normalize(region.code), region);
    for (const key of aliases(region.name, region.native_name, region.zh_name)) addAlias(regionsByName, key, region);
  }
  const cityAliases = new Map();
  for (const city of cities) {
    checkpoint();
    for (const key of aliases(city.name, city.native_name, city.zh_name)) addAlias(cityAliases, key, city);
  }

  const coverage = new Map();
  let matchedAddresses = 0;
  const residentialCount = groups.reduce((total, row) => total + Number(row.address_count || 0), 0);
  for (const row of groups) {
    checkpoint();
    let region = chooseRegion(row, regionsByCode, regionsByName);
    const city = chooseCity(row, region, cityAliases, regionsById);
    if (city?.region_id) region = regionsById.get(Number(city.region_id)) || region;
    if (!region) continue;
    const regionName = String(region.name);
    const cityName = city ? String(city.name) : '';
    const key = JSON.stringify([regionName, cityName]);
    const count = Number(row.address_count || 0);
    matchedAddresses += count;
    const current = coverage.get(key);
    if (current) current.addressCount += count;
    else coverage.set(key, {
      country, regionName, cityName,
      addressCount: count, regionId: Number(region.id), cityId: city ? Number(city.id) : null
    });
  }

  await database.transaction(async (transaction) => {
    checkpoint();
    await transaction.prepare('DELETE FROM residential_coverage WHERE country_code=?').bind(country).run();
    const rows = [...coverage.values()];
    for (let offset = 0; offset < rows.length; offset += 500) {
      checkpoint();
      await transaction.batch(rows.slice(offset, offset + 500).map((row) => transaction.prepare(`
        INSERT INTO residential_coverage(
          country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id
        ) VALUES (?,?,?,?,?,?,?)`).bind(
        row.country, row.regionName, row.cityName, row.addressCount, now, row.regionId, row.cityId
      )));
    }
    await transaction.prepare(`UPDATE admin_coverage_stats SET residential_count=?,
      total_count=ordinary_count+?,updated_at=? WHERE node_key=? AND level=0`)
      .bind(residentialCount, residentialCount, now, country).run();
    checkpoint();
  });
  return {
    countryCode: country,
    groups: groups.length,
    mappedGroups: coverage.size,
    matchedAddresses,
    unmatchedAddresses: residentialCount - matchedAddresses
  };
};
