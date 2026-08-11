import { access, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyncArtifactCleanup } from '../server/sync/artifact-cleanup.mjs';

const roots = [];
const testRoot = () => {
  const root = resolve('.data-cache', 'sync-artifact-cleanup-tests', randomUUID());
  roots.push(root);
  return root;
};
const createFile = async (file, modifiedAt) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'fixture');
  await utimes(file, modifiedAt, modifiedAt);
};
const exists = (file) => access(file).then(() => true, () => false);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('synchronization artifact cleanup', () => {
  it('removes parent-pid artifacts whenever the queue is idle and retains fresh resumable parts', async () => {
    const root = testRoot();
    const current = new Date('2026-08-04T00:00:00Z');
    const old = new Date(current.getTime() - 7 * 60 * 60_000);
    const dead = resolve(root, 'normalized', 'jp.jsonl.999999.tmp');
    const live = resolve(root, 'normalized', 'jp.jsonl.42.tmp');
    const expiredPart = resolve(root, 'raw', 'source.zip.part');
    const freshPart = resolve(root, 'raw', 'current.zip.part');
    const plateau = resolve(root, 'raw', 'plateau-13113-2023');
    const deadDirectory = resolve(root, 'raw', 'extract.999999.tmp');
    const liveDirectory = resolve(root, 'raw', 'extract.42.tmp');
    await Promise.all([
      createFile(dead, current),
      createFile(live, old),
      createFile(expiredPart, old),
      createFile(freshPart, current),
      createFile(resolve(plateau, 'buildings.parquet'), old),
      createFile(resolve(deadDirectory, 'data.json'), current),
      createFile(resolve(liveDirectory, 'data.json'), old)
    ]);
    await utimes(plateau, old, old);
    await utimes(deadDirectory, current, current);
    await utimes(liveDirectory, old, old);

    const cleanup = createSyncArtifactCleanup({
      cacheDir: root,
      now: () => current.getTime(),
      staleMs: 6 * 60 * 60_000,
      log: { log: () => {}, error: () => {} }
    });
    const result = await cleanup.runOnce();

    expect(result).toMatchObject({ removedFiles: 3, removedDirectories: 3, removedBytes: 21 });
    expect(await exists(dead)).toBe(false);
    expect(await exists(expiredPart)).toBe(false);
    expect(await exists(plateau)).toBe(false);
    expect(await exists(deadDirectory)).toBe(false);
    expect(await exists(live)).toBe(false);
    expect(await exists(freshPart)).toBe(true);
    expect(await exists(liveDirectory)).toBe(false);
  });

  it('does not scan while a synchronization job is running', async () => {
    const root = testRoot();
    const file = resolve(root, 'raw', 'source.zip.part');
    await createFile(file, new Date(0));
    const cleanup = createSyncArtifactCleanup({ cacheDir: root, isBusy: () => true });

    await expect(cleanup.runOnce()).resolves.toMatchObject({ skipped: true, removedFiles: 0 });
    expect(await exists(file)).toBe(true);
  });

  it('expires completed task artifacts without deleting checkpoints or shared tool caches', async () => {
    const root = testRoot();
    const current = new Date('2026-08-04T12:00:00Z');
    const old = new Date(current.getTime() - 7 * 60 * 60_000);
    const fresh = new Date(current.getTime() - 60_000);
    const expiredNormalized = resolve(root, 'normalized', 'inegi-mx.jsonl');
    const freshNormalized = resolve(root, 'normalized', 'geofabrik-ca.geojsonseq');
    const expiredRaw = resolve(root, 'raw', 'canada.osm.pbf');
    const checkpoint = resolve(root, 'raw', 'japan-abr-state-0123456789abcdefabcd', 'candidates.duckdb');
    const extension = resolve(root, 'normalized', 'duckdb-home', '.duckdb', 'extensions', 'spatial.duckdb_extension');
    await Promise.all([
      createFile(expiredNormalized, old), createFile(freshNormalized, fresh), createFile(expiredRaw, old),
      createFile(checkpoint, old), createFile(extension, old)
    ]);

    const cleanup = createSyncArtifactCleanup({
      cacheDir: root, now: () => current.getTime(), staleMs: 6 * 60 * 60_000,
      log: { log: () => {}, error: () => {} }
    });
    await cleanup.runOnce();

    expect(await exists(expiredNormalized)).toBe(false);
    expect(await exists(expiredRaw)).toBe(false);
    expect(await exists(freshNormalized)).toBe(true);
    expect(await exists(checkpoint)).toBe(true);
    expect(await exists(extension)).toBe(true);
  });

  it('retains durable Japan checkpoints until the adapter replaces their extraction fingerprint', async () => {
    const root = testRoot();
    const current = new Date('2026-08-07T12:00:00Z');
    const active = resolve(root, 'raw', 'japan-abr-residential-state-0123456789abcdefabcd');
    const abandoned = resolve(root, 'raw', 'japan-abr-residential-state-fedcba98765432100123');
    await Promise.all([
      createFile(resolve(active, 'checkpoint.json'), new Date(current.getTime() - 8 * 60 * 60_000)),
      createFile(resolve(active, 'candidates.duckdb'), new Date(current.getTime() - 8 * 60 * 60_000)),
      createFile(resolve(abandoned, 'checkpoint.json'), new Date(current.getTime() - 25 * 60 * 60_000))
    ]);
    await utimes(active, new Date(current.getTime() - 8 * 60 * 60_000), new Date(current.getTime() - 8 * 60 * 60_000));
    await utimes(abandoned, new Date(current.getTime() - 25 * 60 * 60_000), new Date(current.getTime() - 25 * 60 * 60_000));

    const cleanup = createSyncArtifactCleanup({
      cacheDir: root, now: () => current.getTime(), staleMs: 6 * 60 * 60_000,
      log: { log: () => {}, error: () => {} }
    });
    await cleanup.runOnce();

    expect(await exists(active)).toBe(true);
    expect(await exists(resolve(active, 'candidates.duckdb'))).toBe(true);
    expect(await exists(abandoned)).toBe(true);
  });

  it('stops before removal when a synchronization job starts during a pass', async () => {
    const root = testRoot();
    const file = resolve(root, 'raw', 'source.zip.part');
    await createFile(file, new Date(0));
    let checks = 0;
    const cleanup = createSyncArtifactCleanup({ cacheDir: root, isBusy: () => ++checks > 1 });

    await expect(cleanup.runOnce()).resolves.toMatchObject({ skipped: false, removedFiles: 0 });
    expect(await exists(file)).toBe(true);
  });
});
