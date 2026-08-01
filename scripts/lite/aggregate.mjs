import { mkdir, readFile, readdir, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const arg = (name, fallback = '') => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const input = resolve(arg('--input', resolve(root, '.lite-artifacts')));
const output = resolve(arg('--output', resolve(root, 'public/data')));
const manifest = JSON.parse(await readFile(resolve(root, 'config/lite-targets.json'), 'utf8'));
await mkdir(output, { recursive: true });

const files = [];
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
};
await walk(input);
const jsonFiles = files.filter((file) => file.endsWith('.json') && !relative(input, file).split('/').includes('metrics'));
const byTail = new Map(jsonFiles.map((file) => [relative(input, file).replaceAll('\\', '/'), file]));
const countries = new Map();
let totalAddresses = 0;
for (const target of manifest.targets) {
  let source = byTail.get(target.file);
  if (!source) {
    source = jsonFiles.find((file) => relative(input, file).replaceAll('\\', '/').endsWith(`/${target.file}`));
  }
  if (!source) throw new Error(`Missing target artifact: ${target.file}`);
  const payload = JSON.parse(await readFile(source, 'utf8'));
  const destination = resolve(output, target.file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const countryMeta = manifest.countries[target.country];
  const country = countries.get(target.country) || {
    code: target.country, name: countryMeta.name, nameZh: countryMeta.nameZh, targets: []
  };
  country.targets.push({
    id: target.id, label: target.label, labelZh: target.labelZh, category: target.category,
    scope: target.scope, file: `/data/${target.file}`, note: target.note || '',
    maxAddresses: manifest.candidateProfiles[target.scope].outputCap,
    addresses: payload.stats.addresses, postcodes: payload.stats.postcodes
  });
  countries.set(target.country, country);
  totalAddresses += Number(payload.stats.addresses || 0);
}
const index = {
  schemaVersion: 1,
  profile: manifest.profile,
  generatedAt: new Date().toISOString(),
  maxAddressesPerPostcode: manifest.maxAddressesPerPostcode,
  totalAddresses,
  countries: [...countries.values()].map((country) => ({
    ...country,
    targets: country.targets.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label))
  })).sort((a, b) => a.code.localeCompare(b.code))
};
await writeFile(resolve(output, 'countries.json'), `${JSON.stringify(index)}\n`, 'utf8');
const size = (await stat(resolve(output, 'countries.json'))).size;
console.log(`[address-lite] countries=${index.countries.length} targets=${manifest.targets.length} addresses=${totalAddresses} indexBytes=${size}`);
