import { openPostgresDatabase } from '../server/database/postgres.mjs';
import { parseArgs } from './lib/address-pool.mjs';

const supportedCountries = [
  'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU',
  'CN', 'HK', 'TW', 'JP', 'KR', 'SG', 'VN', 'TH', 'PH', 'MY',
  'IN', 'AU', 'TR', 'SA', 'BR', 'NG', 'ZA'
];
const requiredTables = [
  'schema_migrations', 'address_sources', 'address_datasets', 'address_pool',
  'address_pool_evidence', 'pool_coverage', 'catalog_regions', 'catalog_cities',
  'catalog_postcodes', 'sync_country_state', 'sync_jobs'
];
const hardLimitBytes = 45 * 1024 ** 3;
const args = parseArgs(process.argv.slice(2));
const countries = args.countries
  ? [...new Set(String(args.countries).split(',').map((value) => value.trim().toUpperCase()).filter(Boolean))]
  : supportedCountries;

if (countries.some((country) => !supportedCountries.includes(country))) {
  throw new Error('--countries contains an unsupported country code.');
}

const writeReport = ({ schemaVersion = 0, storageBytes = 0, perCountry = [], errors }) => {
  console.log(JSON.stringify({
    status: errors.length ? 'degraded' : 'ready',
    checkedAt: new Date().toISOString(),
    database: 'postgres',
    schemaVersion,
    storageBytes,
    hardLimitBytes,
    countries: perCountry,
    errors
  }, null, 2));
  if (errors.length) process.exitCode = 1;
};

let database;
try {
  database = await openPostgresDatabase({ migrate: false });
  const tables = await database.prepare(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='address'`).all();
  const existingTables = new Set(tables.results.map(({ table_name }) => table_name));
  const missingTables = requiredTables.filter((table) => !existingTables.has(table));
  const schemaVersion = missingTables.includes('schema_migrations') ? 0 : Number(
    await database.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').first('version') || 0
  );
  const storageBytes = Number(await database.prepare(
    'SELECT pg_database_size(current_database()) AS size'
  ).first('size') || 0);
  const perCountry = [];
  if (!missingTables.includes('address_pool') && !missingTables.includes('sync_country_state')) {
    for (const country of countries) {
      const counts = await database.prepare(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE property_type IN ('residential','apartment') AND residential_evidence=1) AS residential
        FROM address_pool_runtime WHERE country_code=?`).bind(country).first();
      const sync = await database.prepare(`SELECT status,last_success_at,next_sync_at,failure_count,last_error
        FROM sync_country_state WHERE country_code=?`).bind(country).first();
      perCountry.push({
        country,
        total: Number(counts?.total || 0),
        residential: Number(counts?.residential || 0),
        syncStatus: sync?.status || 'pending',
        lastSuccessAt: sync?.last_success_at || null,
        nextSyncAt: sync?.next_sync_at || null,
        failureCount: Number(sync?.failure_count || 0),
        lastError: sync?.last_error || null
      });
    }
  }
  const errors = [
    ...missingTables.map((table) => `required table ${table} is missing`),
    ...(schemaVersion >= 1 ? [] : ['schema version is missing']),
    ...(storageBytes < hardLimitBytes ? [] : ['database reached the 45GB hard limit']),
    ...perCountry.filter(({ total }) => total === 0).map(({ country }) => `${country} has no active addresses`),
    ...perCountry.filter(({ residential }) => residential === 0).map(({ country }) => `${country} has no active residential addresses`),
    ...perCountry.filter(({ syncStatus }) => syncStatus !== 'ready').map(({ country, syncStatus }) => `${country} sync status is ${syncStatus}`),
    ...perCountry.filter(({ failureCount }) => failureCount > 0).map(({ country, failureCount }) => `${country} has ${failureCount} synchronization failures`),
    ...perCountry.filter(({ lastSuccessAt }) => !lastSuccessAt).map(({ country }) => `${country} has no successful synchronization timestamp`),
    ...perCountry.filter(({ nextSyncAt }) => !nextSyncAt).map(({ country }) => `${country} has no next synchronization timestamp`)
  ];
  writeReport({ schemaVersion, storageBytes, perCountry, errors });
} catch (error) {
  writeReport({ errors: [`database could not be checked: ${error instanceof Error ? error.message : String(error)}`] });
} finally {
  await database?.close();
}
