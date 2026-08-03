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
  it('removes dead-process artifacts and expired residuals while retaining active files', async () => {
    const root = testRoot();
    const current = new Date('2026-08-04T00:00:00Z');
    const old = new Date(current.getTime() - 7 * 60 * 60_000);
    const dead = resolve(root, 'normalized', 'jp.jsonl.999999.tmp.candidates.duckdb');
    const live = resolve(root, 'normalized', 'jp.jsonl.42.tmp.candidates.duckdb');
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
      isAlive: (pid) => pid === 42,
      staleMs: 6 * 60 * 60_000,
      log: { log: () => {}, error: () => {} }
    });
    const result = await cleanup.runOnce();

    expect(result).toMatchObject({ removedFiles: 2, removedDirectories: 2, removedBytes: 14 });
    expect(await exists(dead)).toBe(false);
    expect(await exists(expiredPart)).toBe(false);
    expect(await exists(plateau)).toBe(false);
    expect(await exists(deadDirectory)).toBe(false);
    expect(await exists(live)).toBe(true);
    expect(await exists(freshPart)).toBe(true);
    expect(await exists(liveDirectory)).toBe(true);
  });

  it('does not scan while a synchronization job is running', async () => {
    const root = testRoot();
    const file = resolve(root, 'raw', 'source.zip.part');
    await createFile(file, new Date(0));
    const cleanup = createSyncArtifactCleanup({ cacheDir: root, isBusy: () => true });

    await expect(cleanup.runOnce()).resolves.toMatchObject({ skipped: true, removedFiles: 0 });
    expect(await exists(file)).toBe(true);
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
