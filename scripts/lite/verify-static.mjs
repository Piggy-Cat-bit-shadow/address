import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const verifyStatic = async ({ dataRoot = resolve(repositoryRoot, 'public/data'), root = repositoryRoot } = {}) => {
  const resolvedDataRoot = resolve(dataRoot);
  const index = JSON.parse(await readFile(resolve(resolvedDataRoot, 'countries.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(root, 'config/lite-targets.json'), 'utf8'));
  const targetPolicy = new Map(manifest.targets.map((target) => [target.id, manifest.candidateProfiles[target.scope].outputCap]));
  const targetById = new Map(manifest.targets.map((target) => [target.id, target]));
  const expectedTargetIds = new Set(manifest.targets.map((target) => target.id));
  const observedTargetIds = new Set();
  const errors = [];
  let addresses = 0;
  if (index.maxAddressesPerPostcode !== manifest.maxAddressesPerPostcode) errors.push('countries.json postcode cap does not match manifest');
  for (const country of index.countries) {
    if (country.code === 'CN') errors.push('Mainland China must not be present');
    for (const target of country.targets) {
      if (observedTargetIds.has(target.id)) errors.push(`${target.id}: duplicate target in countries.json`);
      observedTargetIds.add(target.id);
      const expectedTarget = targetById.get(target.id);
      if (!expectedTarget) errors.push(`${target.id}: target is not in Lite manifest`);
      const file = resolve(resolvedDataRoot, target.file.replace(/^\/data\//, ''));
      const payload = JSON.parse(await readFile(file, 'utf8'));
      if (payload.country !== country.code) errors.push(`${target.id}: country mismatch`);
      if (payload.target?.id !== target.id) errors.push(`${target.id}: payload target mismatch`);
      const seen = new Set();
      for (const region of payload.regions || []) {
        for (const city of region.cities || []) {
          for (const postcode of city.postcodes || []) {
            if ((postcode.addresses || []).length > index.maxAddressesPerPostcode) errors.push(`${target.id}: more than ${index.maxAddressesPerPostcode} addresses in ${city.name}/${postcode.postcode}`);
            for (const address of postcode.addresses || []) {
              addresses += 1;
              if (!['residential', 'apartment'].includes(address.propertyType)) errors.push(`${target.id}: non-residential property type ${address.id}`);
              if (address.residentialEvidence !== true) errors.push(`${target.id}: missing residential evidence flag ${address.id}`);
              if (!address.street || !address.houseNumber || !Number.isFinite(address.latitude) || !Number.isFinite(address.longitude)) errors.push(`${target.id}: incomplete address ${address.id}`);
              if (expectedTarget && Number.isFinite(address.latitude) && Number.isFinite(address.longitude)) {
                const [minLon, minLat, maxLon, maxLat] = expectedTarget.bounds;
                if (address.longitude < minLon || address.longitude > maxLon || address.latitude < minLat || address.latitude > maxLat) errors.push(`${target.id}: coordinate outside target bounds ${address.id}`);
              }
              if (!address.source?.name || !address.source?.attribution) errors.push(`${target.id}: missing source attribution ${address.id}`);
              if (seen.has(address.id)) errors.push(`${target.id}: duplicate address ${address.id}`);
              seen.add(address.id);
            }
          }
        }
      }
      if (seen.size !== payload.stats.addresses) errors.push(`${target.id}: stats.addresses mismatch`);
      const outputCap = targetPolicy.get(target.id);
      if (Number.isFinite(outputCap) && seen.size > outputCap) errors.push(`${target.id}: target output cap exceeded (${seen.size} > ${outputCap})`);
    }
  }
  for (const targetId of expectedTargetIds) if (!observedTargetIds.has(targetId)) errors.push(`${targetId}: missing from countries.json`);
  if (observedTargetIds.size !== expectedTargetIds.size) errors.push(`target count mismatch (${observedTargetIds.size} != ${expectedTargetIds.size})`);
  if (errors.length) throw new Error(errors.join('\n'));
  return { addresses, targets: observedTargetIds.size, countries: index.countries.length };
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--data');
  const dataRoot = resolve(index >= 0 ? args[index + 1] : resolve(repositoryRoot, 'public/data'));
  try {
    const result = await verifyStatic({ dataRoot });
    console.log(`[address-lite] static verification passed; addresses=${result.addresses}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
