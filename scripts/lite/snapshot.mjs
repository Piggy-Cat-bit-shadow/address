import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FINGERPRINT_ALGORITHM_VERSION } from './data-fingerprint.mjs';
import { verifyStatic } from './verify-static.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_SNAPSHOT_AGE_DAYS = 75;
export const MAX_DATA_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const MAX_TARGET_JSON_BYTES = 500 * 1024;

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const execFileAsync = promisify(execFile);
const shaPattern = /^[0-9a-f]{64}$/u;
const gitShaPattern = /^[0-9a-f]{40}$/u;

export const sha256File = async (path) => {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
};

const walkFiles = async (root) => {
  const output = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  await walk(root);
  return output.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
};

export const hashDataTree = async (dataRoot) => {
  const hash = createHash('sha256');
  for (const path of await walkFiles(dataRoot)) {
    hash.update(`${relative(dataRoot, path).replaceAll('\\', '/')}\0`);
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
};

export const inspectData = async (dataRoot) => {
  const index = JSON.parse(await readFile(resolve(dataRoot, 'countries.json'), 'utf8'));
  const targetAddressCounts = {};
  let largestTargetBytes = 0;
  let largestTargetPath = '';
  for (const country of index.countries || []) {
    for (const target of country.targets || []) {
      const path = resolve(dataRoot, String(target.file || '').replace(/^\/data\//u, ''));
      const bytes = (await stat(path)).size;
      if (bytes > largestTargetBytes) {
        largestTargetBytes = bytes;
        largestTargetPath = relative(dataRoot, path).replaceAll('\\', '/');
      }
      targetAddressCounts[target.id] = Number(target.addresses || 0);
    }
  }
  return {
    totalAddresses: Number(index.totalAddresses || 0),
    targetCount: Object.keys(targetAddressCounts).length,
    countryCount: (index.countries || []).length,
    targetAddressCounts,
    largestTargetBytes,
    largestTargetPath
  };
};

export const assertDataSizeBudget = async (dataRoot) => {
  const stats = await inspectData(dataRoot);
  if (stats.largestTargetBytes > MAX_TARGET_JSON_BYTES) {
    throw new Error(`Target JSON exceeds ${MAX_TARGET_JSON_BYTES} bytes: ${stats.largestTargetPath} (${stats.largestTargetBytes})`);
  }
  return stats;
};

const snapshotId = ({ refreshFingerprint, assembleFingerprint, generatedAt }) => {
  const timestamp = new Date(generatedAt).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  return `${refreshFingerprint.slice(0, 12)}-${assembleFingerprint.slice(0, 8)}-${timestamp}`;
};

export const createSnapshotMetadata = async ({
  dataRoot,
  refreshFingerprint,
  assembleFingerprint,
  generatedAt,
  sourceSha,
  sourceRunId,
  sourceEvent,
  publishedRunId,
  archiveSha256
}) => {
  const generatedTime = new Date(generatedAt);
  if (!Number.isFinite(generatedTime.getTime())) throw new Error('Snapshot generatedAt is invalid');
  if (!shaPattern.test(refreshFingerprint) || !shaPattern.test(assembleFingerprint)) throw new Error('Snapshot fingerprint is invalid');
  if (!gitShaPattern.test(sourceSha)) throw new Error('Snapshot sourceSha is invalid');
  if (!shaPattern.test(archiveSha256)) throw new Error('Snapshot archiveSha256 is invalid');
  const data = await assertDataSizeBudget(dataRoot);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: snapshotId({ refreshFingerprint, assembleFingerprint, generatedAt }),
    fingerprintAlgorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
    refreshFingerprint,
    assembleFingerprint,
    generatedAt: generatedTime.toISOString(),
    sourceSha,
    sourceRunId: String(sourceRunId),
    sourceEvent: String(sourceEvent),
    publishedRunId: String(publishedRunId),
    totalAddresses: data.totalAddresses,
    targetCount: data.targetCount,
    countryCount: data.countryCount,
    targetAddressCounts: data.targetAddressCounts,
    dataTreeSha256: await hashDataTree(dataRoot),
    archiveSha256
  };
};

const positiveRunId = (value) => /^\d+$/u.test(String(value)) && Number(value) > 0;

export const validateSnapshotMetadata = async ({
  metadata,
  dataRoot,
  archiveSha256,
  currentRefreshFingerprint,
  currentAssembleFingerprint,
  now = new Date(),
  expectedPublishedRunId
}) => {
  const errors = [];
  if (metadata?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) errors.push('schema_mismatch');
  if (metadata?.fingerprintAlgorithmVersion !== FINGERPRINT_ALGORITHM_VERSION) errors.push('fingerprint_algorithm_mismatch');
  if (!metadata?.snapshotId || typeof metadata.snapshotId !== 'string') errors.push('snapshot_id_missing');
  if (!shaPattern.test(String(metadata?.refreshFingerprint || ''))) errors.push('refresh_fingerprint_invalid');
  if (!shaPattern.test(String(metadata?.assembleFingerprint || ''))) errors.push('assemble_fingerprint_invalid');
  if (!shaPattern.test(String(metadata?.dataTreeSha256 || ''))) errors.push('data_tree_hash_invalid');
  if (!shaPattern.test(String(metadata?.archiveSha256 || ''))) errors.push('archive_hash_invalid');
  if (!gitShaPattern.test(String(metadata?.sourceSha || ''))) errors.push('source_sha_invalid');
  if (!positiveRunId(metadata?.sourceRunId)) errors.push('source_run_invalid');
  if (!positiveRunId(metadata?.publishedRunId)) errors.push('published_run_invalid');
  if (expectedPublishedRunId && String(metadata?.publishedRunId) !== String(expectedPublishedRunId)) errors.push('published_run_mismatch');
  if (metadata?.archiveSha256 !== archiveSha256) errors.push('checksum_mismatch');
  const generatedTime = new Date(metadata?.generatedAt);
  const ageMs = now.getTime() - generatedTime.getTime();
  const ageDays = ageMs / 86_400_000;
  if (!Number.isFinite(generatedTime.getTime())) errors.push('generated_at_invalid');
  else if (ageMs < -300_000) errors.push('generated_at_in_future');
  else if (ageDays > MAX_SNAPSHOT_AGE_DAYS) errors.push('snapshot_expired');
  let actual;
  try {
    actual = await assertDataSizeBudget(dataRoot);
    if (await hashDataTree(dataRoot) !== metadata?.dataTreeSha256) errors.push('data_tree_hash_mismatch');
    for (const field of ['totalAddresses', 'targetCount', 'countryCount']) {
      if (Number(metadata?.[field]) !== Number(actual[field])) errors.push(`${field}_mismatch`);
    }
    if (JSON.stringify(metadata?.targetAddressCounts || {}) !== JSON.stringify(actual.targetAddressCounts)) errors.push('target_counts_mismatch');
  } catch (error) {
    errors.push(`data_invalid:${error.message}`);
  }
  const refreshCompatible = metadata?.refreshFingerprint === currentRefreshFingerprint;
  const assembleCompatible = metadata?.assembleFingerprint === currentAssembleFingerprint;
  const compatibility = refreshCompatible ? (assembleCompatible ? 'reuse' : 'reassemble') : 'incompatible';
  return {
    valid: errors.length === 0,
    errors,
    compatibility,
    ageDays: Number.isFinite(ageDays) ? Number(ageDays.toFixed(2)) : null,
    stats: actual || null
  };
};

const locateBundleFile = async (bundleRoot, name) => {
  const matches = (await walkFiles(bundleRoot)).filter((path) => basename(path) === name);
  if (matches.length !== 1) throw new Error(`Snapshot bundle must contain exactly one ${name}`);
  return matches[0];
};

const safeArchiveEntries = async (archive) => {
  const { stdout } = await execFileAsync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const entries = stdout.split(/\r?\n/u).filter(Boolean);
  if (!entries.length) throw new Error('Snapshot archive is empty');
  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//u, '');
    if (normalized.startsWith('/') || normalized.split('/').includes('..') || !(normalized === 'public/data' || normalized.startsWith('public/data/'))) {
      throw new Error(`Unsafe snapshot archive entry: ${entry}`);
    }
  }
};

const rejectExtractedLinks = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Snapshot archive contains a symbolic link: ${entry.name}`);
    if (entry.isDirectory()) await rejectExtractedLinks(resolve(directory, entry.name));
    else if (!entry.isFile()) throw new Error(`Snapshot archive contains an unsupported entry: ${entry.name}`);
  }
};

export const restoreSnapshotBundle = async ({
  bundleRoot,
  outputDataRoot,
  currentRefreshFingerprint,
  currentAssembleFingerprint,
  expectedPublishedRunId,
  allowAssembleMismatch = false,
  root = repositoryRoot,
  now = new Date()
}) => {
  const archive = await locateBundleFile(bundleRoot, 'address-lite-data.tar.gz');
  const checksum = await locateBundleFile(bundleRoot, 'address-lite-data.tar.gz.sha256');
  const metadataPath = await locateBundleFile(bundleRoot, 'snapshot.json');
  if ((await stat(archive)).size > MAX_DATA_ARCHIVE_BYTES) throw new Error(`Snapshot archive exceeds ${MAX_DATA_ARCHIVE_BYTES} bytes`);
  const expectedHash = (await readFile(checksum, 'utf8')).trim().split(/\s+/u)[0];
  if (!shaPattern.test(expectedHash)) throw new Error('Snapshot checksum file is malformed');
  const actualHash = await sha256File(archive);
  if (actualHash !== expectedHash) throw new Error('Snapshot archive checksum mismatch');
  await safeArchiveEntries(archive);
  const temporary = await mkdtemp(resolve(tmpdir(), 'address-lite-snapshot-'));
  try {
    await execFileAsync('tar', ['--no-same-owner', '-xzf', archive, '-C', temporary]);
    await rejectExtractedLinks(temporary);
    const extractedData = resolve(temporary, 'public/data');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const validation = await validateSnapshotMetadata({
      metadata,
      dataRoot: extractedData,
      archiveSha256: actualHash,
      currentRefreshFingerprint,
      currentAssembleFingerprint,
      expectedPublishedRunId,
      now
    });
    if (!validation.valid) throw new Error(`Snapshot metadata rejected: ${validation.errors.join(', ')}`);
    if (validation.compatibility === 'incompatible') throw new Error('Snapshot refresh fingerprint is incompatible');
    if (validation.compatibility === 'reassemble' && !allowAssembleMismatch) throw new Error('Snapshot assemble fingerprint is incompatible');
    await verifyStatic({ dataRoot: extractedData, root });
    await rm(outputDataRoot, { recursive: true, force: true });
    await mkdir(resolve(outputDataRoot, '..'), { recursive: true });
    await cp(extractedData, outputDataRoot, { recursive: true });
    return { metadata, validation, archiveSha256: actualHash };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

const arg = (args, name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === 'create') {
    const dataRoot = resolve(arg(args, '--data', resolve(repositoryRoot, 'public/data')));
    const metadata = await createSnapshotMetadata({
      dataRoot,
      refreshFingerprint: arg(args, '--refresh-fingerprint'),
      assembleFingerprint: arg(args, '--assemble-fingerprint'),
      generatedAt: arg(args, '--generated-at'),
      sourceSha: arg(args, '--source-sha'),
      sourceRunId: arg(args, '--source-run-id'),
      sourceEvent: arg(args, '--source-event'),
      publishedRunId: arg(args, '--published-run-id'),
      archiveSha256: arg(args, '--archive-sha256')
    });
    const output = resolve(arg(args, '--output', 'snapshot.json'));
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(output, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(metadata));
  } else if (command === 'restore') {
    const result = await restoreSnapshotBundle({
      bundleRoot: resolve(arg(args, '--bundle')),
      outputDataRoot: resolve(arg(args, '--output-data', resolve(repositoryRoot, 'public/data'))),
      currentRefreshFingerprint: arg(args, '--refresh-fingerprint'),
      currentAssembleFingerprint: arg(args, '--assemble-fingerprint'),
      expectedPublishedRunId: arg(args, '--published-run-id') || undefined,
      allowAssembleMismatch: args.includes('--allow-assemble-mismatch')
    });
    console.log(JSON.stringify({ snapshotId: result.metadata.snapshotId, compatibility: result.validation.compatibility }));
  } else {
    throw new Error('Usage: snapshot.mjs create|restore [options]');
  }
}
