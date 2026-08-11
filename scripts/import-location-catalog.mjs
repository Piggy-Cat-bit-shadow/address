import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openPostgresDatabase } from '../server/database/postgres.mjs';
import { executeSqlStatements } from './sql-statements.mjs';

const input = resolve(process.argv[2]
  || (process.env.LOCATION_CATALOG_CACHE_DIR
    ? resolve(process.env.LOCATION_CATALOG_CACHE_DIR, 'catalog-seed.sql')
    : '.data-cache/catalog-seed.sql'));
const database = await openPostgresDatabase({
  environment: {
    ...process.env,
    POSTGRES_STATEMENT_TIMEOUT_MS: process.env.LOCATION_CATALOG_IMPORT_TIMEOUT_MS || '1800000'
  }
});

try {
  const statementCount = await executeSqlStatements(database, readFileSync(input, 'utf8'), (completed) => {
    if (completed % 500 === 0) console.log(`Imported ${completed} catalog SQL statements`);
  });
  const counts = await database.prepare(`SELECT
    (SELECT COUNT(*) FROM catalog_regions) AS regions,
    (SELECT COUNT(*) FROM catalog_cities) AS cities,
    (SELECT COUNT(*) FROM catalog_postcodes) AS postcodes`).first();
  console.log(JSON.stringify({ database: 'postgres', input, statementCount, ...counts }));
} finally {
  await database.close();
}
