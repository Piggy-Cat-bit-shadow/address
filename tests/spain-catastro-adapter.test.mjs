import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSourceAdapters, loadSourceCatalog, sourceAdapterRevisions
} from '../server/sync/source-adapters.mjs';


const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Spanish Catastro INSPIRE adapter', () => {
  it('expands the three audited municipalities into independent shards', async () => {
    const catalog = await loadSourceCatalog();
    const shards = catalog.shards.filter((shard) => shard.source.adapter === 'spain-catastro-residential');
    expect(sourceAdapterRevisions['spain-catastro-residential']).toBe('inspire-residential-join-v2');
    expect(shards.map((shard) => shard.id)).toEqual([
      'spain-catastro-residential-28900',
      'spain-catastro-residential-37900',
      'spain-catastro-residential-44009'
    ]);
    expect(shards.map((shard) => shard.countryCode)).toEqual(['ES', 'ES', 'ES']);
    expect(shards.every((shard) => shard.source.dataUrl === shard.source.addressesUrl)).toBe(true);
    expect(shards.reduce((sum, shard) => sum + shard.maxRecords, 0)).toBeGreaterThanOrEqual(80000);
  });

  it('discovers both official archives and invokes the strict municipality exporter', async () => {
    const cacheDir = resolve('.data-cache', `catastro-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const sourceShard = catalog.shards.find((shard) => shard.id === 'spain-catastro-residential-44009');
    const shard = { ...sourceShard, qualityGate: { minimumRecords: 1 } };
    const calls = [];
    const fetchImpl = async (_input, init = {}) => {
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'content-length': '1024', 'last-modified': 'Sat, 21 Feb 2026 00:00:00 GMT', etag: '"fixture"'
      } });
      return new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { 'content-length': '4' } });
    };
    const execute = async ({ args, phase }) => {
      calls.push({ args, phase });
      const output = args[args.indexOf('--output') + 1];
      await mkdir(resolve(output, '..'), { recursive: true });
      await writeFile(output, `${JSON.stringify({ id: 'fixture-es' })}\n`);
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'spain-catastro-residential', addressBytes: 1024, buildingBytes: 1024,
      publishedAt: '2026-02-21T00:00:00.000Z', residentialBuildingAvailable: true
    });
    const result = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 1000, perLocality: 350, maxBytes: 4096, retainRaw: false
    });
    expect(result).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(JSON.parse((await readFile(result.file, 'utf8')).trim())).toEqual({ id: 'fixture-es' });
    expect(calls[0]).toMatchObject({ phase: 'materialize:spain-catastro-residential-44009' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('spain-catastro-export.py'),
      '--province', 'Aragón', '--province-code', 'AR',
      '--municipality', 'Albarracín', '--municipality-code', '44009', '--max-records', '500'
    ]));
  });
});
