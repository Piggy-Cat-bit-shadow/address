import { openPostgresDatabase } from '../server/database/postgres.mjs';
import { refreshResidentialCoverage } from '../server/database/residential-coverage.mjs';

const database = await openPostgresDatabase();
try {
  const countries = (await database.prepare(`SELECT DISTINCT country_code FROM address_pool
    WHERE active=1 AND country_code<>'CN' ORDER BY country_code`).all()).results;
  for (const row of countries) {
    const result = await refreshResidentialCoverage(database, String(row.country_code));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally {
  await database.close();
}
