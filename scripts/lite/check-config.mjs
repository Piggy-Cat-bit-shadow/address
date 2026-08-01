import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifest = JSON.parse(await readFile(resolve(root, 'config/lite-targets.json'), 'utf8'));
const errors = [];
const targetIds = new Set();
const files = new Set();
const groupCountries = new Map();
const categories = new Set(['low_tax', 'major_city']);
let outputCap = 0;

if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
if (manifest.maxAddressesPerPostcode !== 3) errors.push('maxAddressesPerPostcode must remain 3');
if (!manifest.countries || typeof manifest.countries !== 'object') errors.push('countries metadata is missing');
if (!manifest.candidateProfiles || typeof manifest.candidateProfiles !== 'object') errors.push('candidateProfiles is missing');

for (const [scope, profile] of Object.entries(manifest.candidateProfiles || {})) {
  const tiers = profile.tiers || [];
  if (!tiers.length || tiers.some((value) => !Number.isSafeInteger(value) || value < 1)) errors.push(`${scope}: invalid candidate tiers`);
  if (tiers.some((value, index) => index > 0 && value <= tiers[index - 1])) errors.push(`${scope}: candidate tiers must be strictly increasing`);
  if (!Number.isSafeInteger(profile.perLocality) || profile.perLocality < 1) errors.push(`${scope}: invalid perLocality`);
  if (!Number.isSafeInteger(profile.outputCap) || profile.outputCap < manifest.maxAddressesPerPostcode) errors.push(`${scope}: invalid outputCap`);
}

for (const target of manifest.targets || []) {
  if (target.country === 'CN') errors.push(`${target.id}: mainland China is not allowed in Lite manifest`);
  if (!manifest.countries?.[target.country]) errors.push(`${target.id}: missing country metadata for ${target.country}`);
  if (!categories.has(target.category)) errors.push(`${target.id}: invalid category ${target.category}`);
  const profile = manifest.candidateProfiles?.[target.scope];
  if (!profile) errors.push(`${target.id}: unknown scope ${target.scope}`);
  else outputCap += profile.outputCap;
  if (!target.id || targetIds.has(target.id)) errors.push(`${target.id || '<blank>'}: duplicate/blank target id`);
  targetIds.add(target.id);
  if (!target.file || files.has(target.file)) errors.push(`${target.id}: duplicate/blank output file ${target.file}`);
  files.add(target.file);
  if (!target.jobGroup) errors.push(`${target.id}: missing jobGroup`);
  const existingCountry = groupCountries.get(target.jobGroup);
  if (existingCountry && existingCountry !== target.country) errors.push(`${target.id}: jobGroup ${target.jobGroup} mixes countries`);
  groupCountries.set(target.jobGroup, target.country);
  if (!Array.isArray(target.bounds) || target.bounds.length !== 4 || target.bounds.some((value) => !Number.isFinite(value))) {
    errors.push(`${target.id}: invalid bounds`);
  } else {
    const [minLon, minLat, maxLon, maxLat] = target.bounds;
    if (!(minLon < maxLon && minLat < maxLat && minLon >= -180 && maxLon <= 180 && minLat >= -90 && maxLat <= 90)) errors.push(`${target.id}: invalid bounds ordering/range`);
  }
}

if (!targetIds.size) errors.push('manifest has no targets');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`[address-lite] config ok countries=${new Set(manifest.targets.map((target) => target.country)).size} targets=${targetIds.size} groups=${groupCountries.size} theoreticalMaxAddresses=${outputCap}`);
}
