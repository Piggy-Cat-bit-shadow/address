import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSourceAdapters, loadSourceCatalog, sourceAdapterRevisions } from '../server/sync/source-adapters.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('France CSTB BDNB residential source', () => {
  it('registers the strict Creuse source independently', async () => {
    const catalog = await loadSourceCatalog();
    expect(sourceAdapterRevisions['france-bdnb-residential']).toBe('bdnb-ban-fiabilite17-v2');
    expect(catalog.shards.find((entry) => entry.id === 'france-bdnb-creuse-residential')).toMatchObject({
      countryCode: 'FR', maxRecords: 50000, qualityGate: { minimumRecords: 30000 },
      source: {
        adapter: 'france-bdnb-residential', sourceVersion: '2026-02.a-schema-0.7.11-dep23',
        minimumFiability: 17
      }
    });
  });

  it('discovers, verifies, materializes and cleans the official archive', async () => {
    const cacheDir = resolve('.data-cache', `france-bdnb-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const configured = catalog.shards.find((entry) => entry.id === 'france-bdnb-creuse-residential');
    const archive = 'archive-fixture';
    const checksum = createHash('sha256').update(archive).digest('hex');
    const shard = {
      ...configured,
      maxRecords: 10,
      qualityGate: { minimumRecords: 1 },
      source: { ...configured.source, sha256: checksum }
    };
    const calls = [];
    const fetchImpl = async (_input, init = {}) => {
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'content-length': String(archive.length),
        'last-modified': 'Fri, 22 May 2026 14:20:23 GMT',
        etag: '"fixture-etag"',
        'x-amz-meta-sha256': checksum
      } });
      return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await mkdir(resolve(args[args.indexOf('--output') + 1], '..'), { recursive: true });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-fr' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'france-bdnb-residential', sourceBytes: archive.length,
      publishedAt: '2026-05-22T14:20:23.000Z', advertisedChecksum: checksum,
      residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 10, perLocality: 8, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({
      format: 'overture-jsonl', cacheHit: false, sourceChecksum: checksum
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:france-bdnb-creuse-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('france-bdnb-export.py'), '--max-records', '10', '--per-locality', '8',
      '--minimum-fiability', '17'
    ]));
  });
});
