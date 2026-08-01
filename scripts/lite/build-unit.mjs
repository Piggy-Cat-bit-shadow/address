import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { runAddressEtl } from '../../server/sync/address-etl.mjs';
import { loadSourceCatalog } from '../../server/sync/source-adapters.mjs';
import { openDatabase } from '../../server/database/sqlite.mjs';
import { emptyResidentialFailure, emptyResidentialMetrics } from './failure-policy.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifestPath = resolve(root, 'config/lite-targets.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const group = arg('--group');
const outRoot = resolve(arg('--out', resolve(root, '.lite-output')));
const workRoot = resolve(arg('--work', resolve(root, '.lite-work')));
if (!group) throw new Error('Usage: node scripts/lite/build-unit.mjs --group <jobGroup> [--out <dir>] [--work <dir>]');

const targets = manifest.targets.filter((target) => target.jobGroup === group);
if (!targets.length) throw new Error(`Unknown Lite job group: ${group}`);
const countries = new Set(targets.map((target) => target.country));
if (countries.size !== 1) throw new Error(`A Lite job group must contain exactly one country: ${group}`);
const country = targets[0].country;
const baseCatalog = await loadSourceCatalog();
const baseShard = baseCatalog.shards.find((shard) => shard.countryCode === country);
if (!baseShard) throw new Error(`No upstream source shard found for ${country}`);
const adapter = baseShard.source.adapter;

process.env.ADDRESS_SYNC_LITE = 'true';
process.env.ADDRESS_SYNC_LITE_CANDIDATE_MULTIPLIER = process.env.ADDRESS_SYNC_LITE_CANDIDATE_MULTIPLIER || '2';
process.env.ADDRESS_SYNC_LITE_MIN_CANDIDATES = process.env.ADDRESS_SYNC_LITE_MIN_CANDIDATES || '32';
process.env.ADDRESS_SYNC_LITE_MAX_CANDIDATES = process.env.ADDRESS_SYNC_LITE_MAX_CANDIDATES || '15000';
process.env.ADDRESS_SYNC_OVERTURE_BUILDINGS = 'true';
process.env.ADDRESS_SYNC_REQUIRE_RESIDENTIAL = 'true';
process.env.ADDRESS_SYNC_TRANSLATION_ENABLED = 'false';
process.env.ADDRESS_SYNC_TRANSLATION_COUNTRIES = '';
process.env.TRANSLATION_BACKFILL_ENABLED = 'false';
process.env.GOOGLE_TRANSLATION_ENABLED = 'false';
process.env.ADDRESS_SYNC_RETAIN_RAW = 'false';

const normalizeMatch = (value) => String(value || '').normalize('NFKD').replace(/\p{M}+/gu, '').trim().toLocaleLowerCase('und');
const within = (row, target) => {
  const [minLon, minLat, maxLon, maxLat] = target.bounds;
  const lon = Number(row.longitude);
  const lat = Number(row.latitude);
  if (!(Number.isFinite(lon) && Number.isFinite(lat) && lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat)) return false;
  if (target.regionAliases?.length) {
    const regionValues = [row.admin1, row.admin1_code].map(normalizeMatch).filter(Boolean);
    const matchesRegion = target.regionAliases.some((alias) => {
      const normalizedAlias = normalizeMatch(alias);
      return regionValues.some((value) => value === normalizedAlias || (normalizedAlias.length > 2 && value.includes(normalizedAlias)));
    });
    if (!matchesRegion) return false;
  }
  return true;
};
const parseJson = (value, fallback = {}) => {
  try { return JSON.parse(value || ''); } catch { return fallback; }
};
const clean = (value) => String(value || '').trim();
const rowToAddress = (row) => {
  const componentVariants = parseJson(row.component_variants_json);
  const addressVariants = parseJson(row.address_variants_json);
  const native = componentVariants.native || {};
  return {
    id: row.id,
    region: clean(row.admin1 || native.admin1),
    regionCode: clean(row.admin1_code || native.admin1Code),
    city: clean(row.postal_locality || row.locality || native.postalLocality || native.locality),
    locality: clean(row.locality || native.locality),
    postalLocality: clean(row.postal_locality || native.postalLocality),
    district: clean(row.district || native.district),
    postcode: clean(row.postcode || native.postcode),
    street: clean(row.street || native.street),
    houseNumber: clean(row.house_number || native.houseNumber),
    buildingName: clean(row.building_name || native.buildingName),
    unit: clean(native.unit),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    propertyType: row.property_type,
    residentialEvidence: Number(row.residential_evidence) === 1,
    qualityScore: Number(row.quality_score),
    formattedAddress: clean(addressVariants.native) || [row.house_number, row.street, row.locality, row.admin1, row.postcode, row.country_code].filter(Boolean).join(', '),
    formattedAddressEn: clean(addressVariants.en),
    formattedAddressZh: clean(addressVariants['zh-CN']),
    source: {
      name: clean(row.source_name),
      url: clean(row.source_url),
      license: clean(row.source_license),
      licenseUrl: clean(row.license_url),
      attribution: clean(row.attribution_text),
      attributionUrl: clean(row.attribution_url),
      datasetVersion: clean(row.dataset_version),
      sourceRecordId: clean(row.source_record_id)
    }
  };
};
const slotKey = (address, target) => {
  const region = address.region || target.label;
  const city = address.city || address.locality || address.district || target.label;
  return [region, city, address.postcode || '*'].map((value) => value.normalize('NFKC').toLocaleLowerCase('und')).join('\u001f');
};
const selectThreePerSlot = (rows, target) => {
  const groups = new Map();
  const sorted = rows.map(rowToAddress).sort((a, b) => b.qualityScore - a.qualityScore || a.id.localeCompare(b.id));
  for (const address of sorted) {
    const key = slotKey(address, target);
    const bucket = groups.get(key) || [];
    if (bucket.length < manifest.maxAddressesPerPostcode) bucket.push(address);
    groups.set(key, bucket);
  }
  const outputCap = manifest.candidateProfiles[target.scope].outputCap;
  const buckets = [...groups.values()].sort((left, right) =>
    Number(right.length === manifest.maxAddressesPerPostcode) - Number(left.length === manifest.maxAddressesPerPostcode)
    || (right[0]?.qualityScore || 0) - (left[0]?.qualityScore || 0)
    || (left[0]?.id || '').localeCompare(right[0]?.id || '')
  );
  const selected = [];
  for (const bucket of buckets) {
    if (selected.length >= outputCap) break;
    selected.push(...bucket.slice(0, Math.max(0, outputCap - selected.length)));
  }
  return selected;
};
const hierarchy = (addresses, target) => {
  const regions = new Map();
  for (const address of addresses) {
    const regionName = address.region || target.label;
    const cityName = address.city || address.locality || address.district || target.label;
    const postcode = address.postcode || '';
    if (!regions.has(regionName)) regions.set(regionName, new Map());
    const cities = regions.get(regionName);
    if (!cities.has(cityName)) cities.set(cityName, new Map());
    const postcodes = cities.get(cityName);
    if (!postcodes.has(postcode)) postcodes.set(postcode, []);
    postcodes.get(postcode).push(address);
  }
  return [...regions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, cities]) => ({
    name,
    cities: [...cities.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cityName, postcodes]) => ({
      name: cityName,
      postcodes: [...postcodes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([postcode, addresses]) => ({ postcode, addresses }))
    }))
  }));
};
const readVerifiedRows = async (databasePath) => {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const result = await database.prepare(`SELECT
      id,country_code,admin1,admin1_code,locality,postal_locality,district,postcode,street,house_number,
      building_name,latitude,longitude,native_language,component_variants_json,address_variants_json,
      property_type,quality_score,source_record_id,dataset_version,source_license,license_url,source_name,
      source_url,attribution_text,attribution_url,residential_evidence
      FROM address_pool_runtime
      WHERE active=1 AND residential_evidence=1 AND property_type IN ('residential','apartment')`).all();
    return result.results;
  } finally {
    database.close();
  }
};
const tierCount = (target, tier) => manifest.candidateProfiles[target.scope].tiers[Math.min(tier, manifest.candidateProfiles[target.scope].tiers.length - 1)];
const perLocality = (target) => manifest.candidateProfiles[target.scope].perLocality;
const maxTier = Math.max(...targets.map((target) => manifest.candidateProfiles[target.scope].tiers.length)) - 1;

const buildAttempt = async (attemptTargets, tier, syntheticBounds) => {
  const identity = attemptTargets.length === 1 ? attemptTargets[0].id : group;
  const key = `${identity}-t${tier}`;
  const attemptRoot = resolve(workRoot, key);
  const databasePath = resolve(attemptRoot, 'data/address.sqlite');
  const cacheDir = resolve(workRoot, `${country}-shared-cache`);
  await rm(attemptRoot, { recursive: true, force: true });
  await mkdir(dirname(databasePath), { recursive: true });
  const maxRecords = attemptTargets.reduce((sum, target) => sum + tierCount(target, tier), 0);
  const localityLimit = Math.max(...attemptTargets.map(perLocality));
  const shard = {
    ...baseShard,
    id: `lite-${identity.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-t${tier}`,
    qualityGate: { minimumRecords: 1, minimumAdmin1: 0, minimumCountRatio: 0, minimumAdmin1Ratio: 0 },
    ...(adapter === 'geofabrik'
      ? { boundsList: syntheticBounds }
      : { bounds: syntheticBounds[0], sourceSamplePercent: [25, 50, 100][Math.min(tier, 2)] })
  };
  const catalog = { ...baseCatalog, shards: [shard] };
  const started = performance.now();
  let result;
  let rows;
  try {
    result = await runAddressEtl({
      databasePath,
      cacheDir,
      dataRoot: resolve(attemptRoot, 'data'),
      requestedShards: [shard.id],
      force: true,
      syncMode: 'manual',
      softLimitBytes: 8 * 1024 ** 3,
      hardLimitBytes: 11 * 1024 ** 3,
      maxRecords,
      perLocality: localityLimit,
      maxShardsPerRun: 1,
      requireResidential: true,
      retainRaw: false,
      prepareConcurrency: 1,
      cpuConcurrency: 1,
      catalog
    });
    rows = await readVerifiedRows(databasePath);
  } catch (error) {
    if (!emptyResidentialFailure(error)) throw error;
    const metrics = emptyResidentialMetrics(error);
    console.warn(`[address-lite] ${identity} tier=${tier} produced no verified residential rows; recording shortage and continuing strict retries`);
    result = { reports: [{ ...metrics }] };
    rows = [];
  }
  return { result, rows, databasePath, elapsedMs: Math.round(performance.now() - started), maxRecords, localityLimit };
};

const outputs = [];
if (adapter === 'geofabrik') {
  // A Geofabrik retry would have to scan the same PBF again. Use the final (still small)
  // candidate tier once, so the expensive source scan happens only once per shared extract.
  const tier = maxTier;
  const attempt = await buildAttempt(targets, tier, targets.map((target) => target.bounds));
  const selected = new Map(targets.map((target) => [target.id, selectThreePerSlot(attempt.rows.filter((row) => within(row, target)), target)]));
  const success = { ...attempt, tier, selected };
  for (const target of targets) outputs.push({ target, addresses: selected.get(target.id) || [], attempt: success });
} else {
  for (const target of targets) {
    const targetMaxTier = manifest.candidateProfiles[target.scope].tiers.length - 1;
    let success = null;
    for (let tier = 0; tier <= targetMaxTier; tier += 1) {
      const attempt = await buildAttempt([target], tier, [target.bounds]);
      const selected = selectThreePerSlot(attempt.rows.filter((row) => within(row, target)), target);
      success = { ...attempt, tier, selected };
      if (selected.length >= 3 || tier === targetMaxTier) break;
      console.warn(`[address-lite] ${target.id} retry tier=${tier + 1}; verified=${selected.length}`);
    }
    outputs.push({ target, addresses: success.selected, attempt: success });
  }
}

for (const { target, addresses, attempt } of outputs) {
  const tree = hierarchy(addresses, target);
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    country,
    target: {
      id: target.id, label: target.label, labelZh: target.labelZh, category: target.category,
      scope: target.scope, bounds: target.bounds, note: target.note || '',
      ...(target.tax ? { tax: { ...target.tax } } : {})
    },
    stats: {
      addresses: addresses.length,
      regions: tree.length,
      cities: tree.reduce((sum, region) => sum + region.cities.length, 0),
      postcodes: tree.reduce((sum, region) => sum + region.cities.reduce((subtotal, city) => subtotal + city.postcodes.length, 0), 0),
      maxAddressesPerPostcode: manifest.maxAddressesPerPostcode,
      maxAddressesPerTarget: manifest.candidateProfiles[target.scope].outputCap,
      retryTier: attempt.tier,
      candidateTarget: attempt.maxRecords,
      sourceSamplePercent: adapter === 'overture' ? [25, 50, 100][Math.min(attempt.tier, 2)] : 100,
      candidateLimit: Math.min(
        Number(process.env.ADDRESS_SYNC_LITE_MAX_CANDIDATES || 15_000),
        Math.max(Number(process.env.ADDRESS_SYNC_LITE_MIN_CANDIDATES || 32),
          attempt.maxRecords * Number(process.env.ADDRESS_SYNC_LITE_CANDIDATE_MULTIPLIER || 2))
      ),
      elapsedMs: attempt.elapsedMs,
      acceptedByImporter: Number(attempt.result.reports?.[0]?.acceptedCount || 0),
      rejectedByImporter: Number(attempt.result.reports?.[0]?.rejectedCount || 0),
      sourceBytes: Number(attempt.result.reports?.[0]?.sourceBytes || 0),
      sourceSizeEstimateMethod: String(attempt.result.reports?.[0]?.estimateMethod || ''),
      estimatedStoragePeakBytes: Number(attempt.result.reports?.[0]?.estimatedStoragePeakBytes || 0),
      storageBytesAfterImport: Number(attempt.result.reports?.[0]?.storageBytesAfterImport || 0)
    },
    regions: tree
  };
  const file = resolve(outRoot, target.file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
  const metricFile = resolve(outRoot, 'metrics', `${target.id}.json`);
  await mkdir(dirname(metricFile), { recursive: true });
  await writeFile(metricFile, `${JSON.stringify({ targetId: target.id, country, adapter, ...payload.stats }, null, 2)}\n`, 'utf8');
  if (addresses.length < 3) console.warn(`[address-lite] WARNING ${target.id}: only ${addresses.length} verified residential addresses`);
  else console.log(`[address-lite] ${target.id}: ${addresses.length} static addresses, ${payload.stats.postcodes} postcode slots`);
}

// Temporary SQLite, Python/DuckDB output and raw PBF never leave the Actions runner.
await rm(workRoot, { recursive: true, force: true }).catch(() => {});
