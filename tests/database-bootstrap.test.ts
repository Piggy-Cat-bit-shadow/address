import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureLocationCatalog } from '../server/database/bootstrap';
import type { PostgresDatabase } from '../server/database/postgres.mjs';

const databaseWithCounts = (...counts: Array<Record<string, number>>): PostgresDatabase => ({
  prepare: () => ({
    first: async () => counts.shift() || { regions: 0, cities: 0, postcodes: 0 }
  })
} as unknown as PostgresDatabase);

describe('database bootstrap', () => {
  const expected = { regions: 10, cities: 20, postcodes: 30 };

  it('does not rebuild an already complete location catalog', async () => {
    const runScript = vi.fn(async () => undefined);
    await expect(ensureLocationCatalog(databaseWithCounts(expected), {}, { expected, runScript }))
      .resolves.toEqual(expected);
    expect(runScript).not.toHaveBeenCalled();
  });

  it('builds and verifies a missing location catalog in dependency order', async () => {
    const scripts: string[] = [];
    const runScript = vi.fn(async (script: string) => { scripts.push(script); });
    await expect(ensureLocationCatalog(
      databaseWithCounts({ regions: 0, cities: 0, postcodes: 0 }, expected),
      {},
      { expected, runScript }
    )).resolves.toEqual(expected);
    expect(scripts).toEqual([
      'scripts/sync-location-catalog.mjs',
      'scripts/import-location-catalog.mjs'
    ]);
  });

  it('indexes staging identifiers before anti-join catalog reconciliation', () => {
    const source = readFileSync(resolve('scripts/sync-location-catalog.mjs'), 'utf8');
    expect(source).toContain('CREATE UNIQUE INDEX catalog_postcodes_staging_id_idx');
    expect(source).toContain('WHERE NOT EXISTS (SELECT 1 FROM catalog_postcodes_staging');
    expect(source).not.toContain('id NOT IN (SELECT id FROM catalog_postcodes_staging)');
  });
});
