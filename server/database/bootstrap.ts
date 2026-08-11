import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PostgresDatabase } from './postgres.mjs';

const execFileAsync = promisify(execFile);
const appRoot = resolve(import.meta.dirname, '..', '..');

type CatalogCounts = { regions: number; cities: number; postcodes: number };
type BootstrapOptions = {
  expected?: CatalogCounts;
  runScript?: (script: string) => Promise<void>;
};

const catalogCounts = async (database: PostgresDatabase): Promise<CatalogCounts> => {
  const row = await database.prepare(`SELECT
    (SELECT COUNT(*) FROM catalog_regions) AS regions,
    (SELECT COUNT(*) FROM catalog_cities) AS cities,
    (SELECT COUNT(*) FROM catalog_postcodes) AS postcodes`).first() as Record<string, unknown>;
  return {
    regions: Number(row?.regions || 0),
    cities: Number(row?.cities || 0),
    postcodes: Number(row?.postcodes || 0)
  };
};

export const ensureLocationCatalog = async (
  database: PostgresDatabase,
  environment: NodeJS.ProcessEnv = process.env,
  options: BootstrapOptions = {}
): Promise<CatalogCounts> => {
  const expected = options.expected || (JSON.parse(
    await readFile(resolve(appRoot, 'src/domain/location-catalog.meta.json'), 'utf8')
  ) as { totals: CatalogCounts }).totals;
  const current = await catalogCounts(database);
  const complete = Object.entries(expected).every(([key, count]) =>
    current[key as keyof CatalogCounts] >= Number(count));
  if (complete) return current;

  for (const script of ['scripts/sync-location-catalog.mjs', 'scripts/import-location-catalog.mjs']) {
    if (options.runScript) await options.runScript(script);
    else {
      await execFileAsync(process.execPath, [resolve(appRoot, script)], {
        cwd: appRoot,
        env: environment,
        timeout: 60 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true
      });
    }
  }
  const imported = await catalogCounts(database);
  const missing = Object.entries(expected).filter(([key, count]) =>
    imported[key as keyof CatalogCounts] < Number(count));
  if (missing.length) {
    throw new Error(`Location catalog bootstrap incomplete: ${missing.map(([key]) => key).join(', ')}`);
  }
  return imported;
};
