import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openPostgresDatabase } from '../server/database/postgres.mjs';

const input = resolve(process.argv[2] || '.data-cache/catalog-seed.sql');
const database = await openPostgresDatabase();

try {
  await database.exec(readFileSync(input, 'utf8'));
  const counts = await database.prepare(`SELECT
    (SELECT COUNT(*) FROM catalog_regions) AS regions,
    (SELECT COUNT(*) FROM catalog_cities) AS cities,
    (SELECT COUNT(*) FROM catalog_postcodes) AS postcodes`).first();
  console.log(JSON.stringify({ database: 'postgres', input, ...counts }));
} finally {
  await database.close();
}
