import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FINGERPRINT_ALGORITHM_VERSION,
  assembleCodeInputs,
  computeDataFingerprints,
  refreshCodeInputs
} from '../scripts/lite/data-fingerprint.mjs';
import {
  MAX_DATA_ARCHIVE_BYTES,
  MAX_SNAPSHOT_AGE_DAYS,
  SNAPSHOT_SCHEMA_VERSION,
  createSnapshotMetadata,
  validateSnapshotMetadata
} from '../scripts/lite/snapshot.mjs';
import { decideFromCandidate, isTrustedSnapshotRun, workflowRequest } from '../scripts/lite/resolve-data.mjs';
import { compareSnapshots } from '../scripts/lite/compare-snapshot.mjs';
import { createBuildInfo } from '../scripts/lite/build-info.mjs';
import { verifyStatic } from '../scripts/lite/verify-static.mjs';

const temporaryRoots = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const manifest = (overrides = {}) => ({
  schemaVersion: 1,
  profile: 'strict-residential-v15',
  maxAddressesPerPostcode: 3,
  candidateProfiles: { region: { tiers: [10, 20], perLocality: 3, outputCap: 24 } },
  countries: { US: { name: 'United States', nameZh: '美国' } },
  targets: [{
    id: 'US-DE', country: 'US', category: 'low_tax', scope: 'region', jobGroup: 'US-DE', file: 'US/DE.json',
    label: 'Delaware', labelZh: '特拉华州', bounds: [-76, 38, -75, 40], regionAliases: ['DE'],
    note: '', tax: { type: 'tax_free', rate: '≈ 0%', label: 'Sales Tax', note: '', noteZh: '' },
    ...overrides
  }]
});

const writeFixtureRepository = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'lite-fingerprint-test-'));
  temporaryRoots.push(root);
  await mkdir(resolve(root, 'config'), { recursive: true });
  await writeFile(resolve(root, 'config/lite-targets.json'), JSON.stringify(manifest()));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ dependencies: { 'opencc-js': '1', 'pinyin-pro': '1', react: '1' } }));
  await writeFile(resolve(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      'node_modules/opencc-js': { version: '1.4.1', integrity: 'sha-opencc' },
      'node_modules/pinyin-pro': { version: '3.28.1', integrity: 'sha-pinyin' },
      'node_modules/react': { version: '19.0.0', integrity: 'sha-react' }
    }
  }));
  for (const entry of new Set([...refreshCodeInputs, ...assembleCodeInputs])) {
    const path = entry.includes('.') ? resolve(root, entry) : resolve(root, entry, 'fixture.mjs');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `fixture:${entry}\n`);
  }
  return root;
};

const dataFixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'lite-data-test-'));
  temporaryRoots.push(root);
  const dataRoot = resolve(root, 'public/data');
  await mkdir(resolve(dataRoot, 'US'), { recursive: true });
  const address = {
    id: 'one', propertyType: 'residential', residentialEvidence: true, street: 'MAIN STREET', houseNumber: '1',
    latitude: 39, longitude: -75.5, source: { name: 'Overture', attribution: 'Overture Maps Foundation' }
  };
  const target = { schemaVersion: 1, generatedAt: '2026-08-01T00:00:00.000Z', country: 'US', target: { id: 'US-DE' }, stats: { addresses: 1 }, regions: [{ name: 'DE', cities: [{ name: 'DOVER', postcodes: [{ postcode: '19901', addresses: [address] }] }] }] };
  await writeFile(resolve(dataRoot, 'US/DE.json'), JSON.stringify(target));
  await writeFile(resolve(dataRoot, 'countries.json'), JSON.stringify({
    schemaVersion: 1, maxAddressesPerPostcode: 3, totalAddresses: 1,
    countries: [{ code: 'US', targets: [{ id: 'US-DE', file: '/data/US/DE.json', addresses: 1 }] }]
  }));
  await mkdir(resolve(root, 'config'), { recursive: true });
  await writeFile(resolve(root, 'config/lite-targets.json'), JSON.stringify(manifest()));
  return { root, dataRoot };
};

describe('Address Lite dual fingerprints', () => {
  it('ignores frontend-only changes but invalidates source/residential changes', async () => {
    const root = await writeFixtureRepository();
    const before = await computeDataFingerprints({ root });
    await mkdir(resolve(root, 'src/components'), { recursive: true });
    await writeFile(resolve(root, 'src/components/LiteApp.css'), '.changed{}\n');
    expect(await computeDataFingerprints({ root })).toEqual(before);
    await writeFile(resolve(root, 'scripts/lite/build-native.mjs'), 'changed');
    expect((await computeDataFingerprints({ root })).refreshFingerprint).not.toBe(before.refreshFingerprint);
  });

  it('keeps tax/display metadata out of refresh while changing assemble', async () => {
    const root = await writeFixtureRepository();
    const before = await computeDataFingerprints({ root });
    const changed = manifest({ label: 'Delaware display', tax: { type: 'tax_free', rate: '≈ 0%', label: 'Sales Tax', note: 'changed', noteZh: '变更' } });
    await writeFile(resolve(root, 'config/lite-targets.json'), JSON.stringify(changed));
    const after = await computeDataFingerprints({ root });
    expect(after.refreshFingerprint).toBe(before.refreshFingerprint);
    expect(after.assembleFingerprint).not.toBe(before.assembleFingerprint);
  });

  it('invalidates refresh for bbox and candidate-profile changes', async () => {
    const root = await writeFixtureRepository();
    const before = await computeDataFingerprints({ root });
    await writeFile(resolve(root, 'config/lite-targets.json'), JSON.stringify(manifest({ bounds: [-77, 38, -75, 40] })));
    expect((await computeDataFingerprints({ root })).refreshFingerprint).not.toBe(before.refreshFingerprint);
    const changedProfiles = manifest();
    changedProfiles.candidateProfiles.region.outputCap = 25;
    await writeFile(resolve(root, 'config/lite-targets.json'), JSON.stringify(changedProfiles));
    expect((await computeDataFingerprints({ root })).refreshFingerprint).not.toBe(before.refreshFingerprint);
  });
});

describe('Address Lite snapshot policy', () => {
  it('accepts compatible metadata and selects reuse/reassemble/refresh safely', async () => {
    const { dataRoot } = await dataFixture();
    const hash = createHash('sha256').update('archive').digest('hex');
    const refresh = createHash('sha256').update('refresh').digest('hex');
    const assemble = createHash('sha256').update('assemble').digest('hex');
    const metadata = await createSnapshotMetadata({
      dataRoot, refreshFingerprint: refresh, assembleFingerprint: assemble, generatedAt: '2026-08-01T00:00:00.000Z',
      sourceSha: 'a'.repeat(40), sourceRunId: '100', sourceEvent: 'workflow_dispatch', publishedRunId: '100', archiveSha256: hash
    });
    const valid = await validateSnapshotMetadata({
      metadata, dataRoot, archiveSha256: hash, currentRefreshFingerprint: refresh, currentAssembleFingerprint: assemble,
      expectedPublishedRunId: '100', now: new Date('2026-08-02T00:00:00.000Z')
    });
    expect(valid).toMatchObject({ valid: true, compatibility: 'reuse', ageDays: 1 });
    expect(decideFromCandidate({ request: workflowRequest({ eventName: 'workflow_dispatch', requestedMode: 'auto' }), candidate: valid })).toEqual({ decision: 'reuse', reason: 'compatible_snapshot' });
    expect(decideFromCandidate({ request: workflowRequest({ eventName: 'workflow_dispatch', requestedMode: 'auto' }), candidate: { compatibility: 'reassemble' } })).toEqual({ decision: 'reassemble', reason: 'assemble_fingerprint_changed' });
    expect(decideFromCandidate({ request: workflowRequest({ eventName: 'workflow_dispatch', requestedMode: 'auto' }), candidate: null })).toEqual({ decision: 'refresh', reason: 'no_compatible_snapshot' });
  });

  it('fails closed for expiry, checksum, schema, algorithm and malformed metadata', async () => {
    const { dataRoot } = await dataFixture();
    const hash = '1'.repeat(64);
    const fingerprint = '2'.repeat(64);
    const base = await createSnapshotMetadata({
      dataRoot, refreshFingerprint: fingerprint, assembleFingerprint: fingerprint, generatedAt: '2026-01-01T00:00:00.000Z',
      sourceSha: 'a'.repeat(40), sourceRunId: '100', sourceEvent: 'schedule', publishedRunId: '100', archiveSha256: hash
    });
    const inspect = (metadata, archiveSha256 = hash) => validateSnapshotMetadata({
      metadata, dataRoot, archiveSha256, currentRefreshFingerprint: fingerprint, currentAssembleFingerprint: fingerprint,
      expectedPublishedRunId: '100', now: new Date('2026-04-01T00:00:00.000Z')
    });
    expect((await inspect(base)).errors).toContain('snapshot_expired');
    expect((await inspect({ ...base, generatedAt: '2026-03-01T00:00:00.000Z' }, '3'.repeat(64))).errors).toContain('checksum_mismatch');
    expect((await inspect({ ...base, generatedAt: '2026-03-01T00:00:00.000Z', schemaVersion: 2 })).errors).toContain('schema_mismatch');
    expect((await inspect({ ...base, generatedAt: '2026-03-01T00:00:00.000Z', fingerprintAlgorithmVersion: FINGERPRINT_ALGORITHM_VERSION + 1 })).errors).toContain('fingerprint_algorithm_mismatch');
    expect((await inspect({})).valid).toBe(false);
  });

  it('rejects data that the current strict static verifier no longer accepts', async () => {
    const { root, dataRoot } = await dataFixture();
    const targetPath = resolve(dataRoot, 'US/DE.json');
    const payload = JSON.parse(await readFile(targetPath, 'utf8'));
    payload.regions[0].cities[0].postcodes[0].addresses[0].residentialEvidence = false;
    await writeFile(targetPath, JSON.stringify(payload));
    await expect(verifyStatic({ dataRoot, root })).rejects.toThrow('missing residential evidence');
  });

  it('trusts only successful main runs from the exact workflow', () => {
    const valid = { workflow_id: 7, head_branch: 'main', status: 'completed', conclusion: 'success', event: 'workflow_dispatch' };
    expect(isTrustedSnapshotRun(valid, { workflowId: 7 })).toBe(true);
    expect(isTrustedSnapshotRun({ ...valid, head_branch: 'feature' }, { workflowId: 7 })).toBe(false);
    expect(isTrustedSnapshotRun({ ...valid, workflow_id: 8 }, { workflowId: 7 })).toBe(false);
    expect(isTrustedSnapshotRun({ ...valid, conclusion: 'failure' }, { workflowId: 7 })).toBe(false);
  });

  it('forces refresh+deploy for schedule and preserves data provenance in site builds', () => {
    expect(workflowRequest({ eventName: 'schedule', requestedMode: 'auto', deploy: false })).toEqual({ requestedMode: 'refresh', deployRequested: true, forcedReason: 'scheduled_refresh' });
    expect(workflowRequest({ eventName: 'workflow_dispatch', requestedMode: 'refresh', deploy: false }).forcedReason).toBe('forced_refresh');
    const snapshot = { snapshotId: 'data-id', sourceSha: 'a'.repeat(40), generatedAt: '2026-01-01T00:00:00.000Z', totalAddresses: 1, targetCount: 1, countryCount: 1 };
    const info = createBuildInfo({ snapshot, siteSha: 'b'.repeat(40), siteBuiltAt: '2026-02-01T00:00:00.000Z', dataMode: 'reuse' });
    expect(info.siteSha).not.toBe(info.dataSourceSha);
    expect(info.dataGeneratedAt).toBe(snapshot.generatedAt);
  });

  it('reports refresh deltas without making address-count movement a hard failure', () => {
    const delta = compareSnapshots({ snapshotId: 'old', totalAddresses: 10, targetAddressCounts: { A: 3, B: 2 } }, { snapshotId: 'new', totalAddresses: 8, targetAddressCounts: { A: 2, B: 3 } });
    expect(delta).toMatchObject({ delta: -2, targetsIncreased: 1, targetsDecreased: 1, previousShortageTargets: 1, currentShortageTargets: 1 });
  });

  it('keeps explicit schema, age and size guard constants', () => {
    expect(SNAPSHOT_SCHEMA_VERSION).toBe(1);
    expect(MAX_SNAPSHOT_AGE_DAYS).toBe(75);
    expect(MAX_DATA_ARCHIVE_BYTES).toBe(5 * 1024 * 1024);
  });
});
