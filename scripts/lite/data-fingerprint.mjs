import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FINGERPRINT_ALGORITHM_VERSION = 1;

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const refreshCodeInputs = Object.freeze([
  'config/lite-seeds.json',
  'scripts/lite/build-native.mjs',
  'scripts/lite/check-config.mjs',
  'scripts/lite/data-fingerprint.mjs',
  'scripts/lite/verify-static.mjs',
]);

export const assembleCodeInputs = Object.freeze([
  'scripts/lite/aggregate.mjs',
  'scripts/lite/data-fingerprint.mjs',
  'scripts/lite/verify-static.mjs'
]);

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));

export const refreshManifestProjection = (manifest) => ({
  schemaVersion: manifest.schemaVersion,
  profile: manifest.profile,
  maxAddressesPerPostcode: manifest.maxAddressesPerPostcode,
  candidateProfiles: Object.fromEntries(Object.entries(manifest.candidateProfiles).map(([scope, profile]) => [scope, { outputCap: profile.outputCap }])),
  targets: (manifest.targets || []).map((target) => ({
    id: target.id,
    country: target.country,
    scope: target.scope,
    bounds: target.bounds,
    regionAliases: target.regionAliases || [],
  })).sort((left, right) => left.id.localeCompare(right.id))
});

export const assembleManifestProjection = (manifest) => canonicalize(manifest);

export const refreshRuntimeProjection = async () => ({ nodeMajor: 24, engine: 'osm-overpass-native-v1' });

const filesUnder = async (root, entry) => {
  const absolute = resolve(root, entry);
  let details;
  try {
    details = await stat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Fingerprint input is missing: ${entry}`);
    throw error;
  }
  if (details.isFile()) return [absolute];
  if (!details.isDirectory()) throw new Error(`Unsupported fingerprint input: ${entry}`);
  const output = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const child of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = resolve(directory, child.name);
      if (child.isDirectory()) await walk(childPath);
      else if (child.isFile()) output.push(childPath);
    }
  };
  await walk(absolute);
  return output;
};

const hashInputs = async ({ root, label, manifestProjection, entries }) => {
  const paths = (await Promise.all(entries.map((entry) => filesUnder(root, entry))))
    .flat()
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const hash = createHash('sha256');
  hash.update(`address-lite:${label}:fingerprint-algorithm-v${FINGERPRINT_ALGORITHM_VERSION}\0`);
  hash.update(`manifest\0${canonicalJson(manifestProjection)}\0`);
  for (const path of paths) {
    const name = relative(root, path).replaceAll('\\', '/');
    hash.update(`${name}\0`);
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
};

export const computeDataFingerprints = async ({ root = repositoryRoot } = {}) => {
  const manifest = JSON.parse(await readFile(resolve(root, 'config/lite-targets.json'), 'utf8'));
  const runtime = await refreshRuntimeProjection(root);
  const [refreshFingerprint, assembleFingerprint] = await Promise.all([
    hashInputs({
      root,
      label: 'refresh',
      manifestProjection: { manifest: refreshManifestProjection(manifest), runtime },
      entries: refreshCodeInputs
    }),
    hashInputs({
      root,
      label: 'assemble',
      manifestProjection: assembleManifestProjection(manifest),
      entries: assembleCodeInputs
    })
  ]);
  return { algorithmVersion: FINGERPRINT_ALGORITHM_VERSION, refreshFingerprint, assembleFingerprint };
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await computeDataFingerprints();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    console.log(`refreshFingerprint=${result.refreshFingerprint}`);
    console.log(`assembleFingerprint=${result.assembleFingerprint}`);
  }
}
