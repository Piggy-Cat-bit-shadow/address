import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DataType, newDb } from 'pg-mem';
import { PostgresDatabase } from '../../server/database/postgres.mjs';

const addressSchema = new URL('../../server/database/schema.sql', import.meta.url);
const initialized = new WeakMap();
const addressSource = await readFile(fileURLToPath(addressSchema), 'utf8');

const testSchema = (source) => String(source)
  .replace(/\s+CHECK\s*\([a-z_]+\s+IS\s+JSON\)/giu, '')
  .replace(/UPDATE address_pool SET[\s\S]*?WHERE country_code='NL' AND admin1='Frieland';/u, '')
  .replace(/DROP VIEW IF EXISTS address_pool_runtime;/u, '')
  .replace(/CREATE VIEW address_pool_runtime AS[\s\S]*?WHERE address_pool\.active = 1;/u, `CREATE VIEW address_pool_runtime AS
    SELECT address_pool.*,address_pool_evidence.id AS evidence_id,address_pool_evidence.source_record_id,
      address_pool_evidence.record_url,address_pool_evidence.observed_at,address_pool_evidence.evidence_type,
      CASE WHEN residential.address_id IS NULL THEN 0 ELSE 1 END AS residential_evidence,
      address_datasets.id AS dataset_id,address_datasets.version AS dataset_version,
      address_datasets.published_at AS source_updated_at,address_datasets.imported_at,
      address_datasets.license_code AS source_license,address_datasets.license_url,
      address_sources.id AS source_id,address_sources.name AS source_name,address_sources.homepage_url AS source_url,
      address_sources.attribution_text,address_sources.attribution_url
    FROM address_pool
    JOIN address_pool_evidence ON address_pool_evidence.address_id=address_pool.id
      AND address_pool_evidence.is_primary=1 AND address_pool_evidence.is_current=1
      AND address_pool_evidence.evidence_type='address_existence'
    LEFT JOIN (SELECT DISTINCT address_id FROM address_pool_evidence
      WHERE evidence_type='residential_use' AND is_current=1) residential ON residential.address_id=address_pool.id
    JOIN address_datasets ON address_datasets.id=address_pool_evidence.dataset_id
      AND address_datasets.status='active' AND address_datasets.redistribution_allowed=1
    JOIN address_sources ON address_sources.id=address_datasets.source_id AND address_sources.redistribution_allowed=1
    WHERE address_pool.active=1;`)
  .replace(/INSERT INTO schema_migrations\(version, applied_at\)[\s\S]*?ON CONFLICT \(version\) DO NOTHING;/u,
    "INSERT INTO schema_migrations(version,applied_at) VALUES (1,'2026-01-01T00:00:00Z'),(2,'2026-01-01T00:00:00Z'),(3,'2026-01-01T00:00:00Z'),(4,'2026-01-01T00:00:00Z'),(5,'2026-01-01T00:00:00Z'),(6,'2026-01-01T00:00:00Z'),(7,'2026-01-01T00:00:00Z'),(8,'2026-01-01T00:00:00Z'),(9,'2026-01-01T00:00:00Z'),(10,'2026-01-01T00:00:00Z'),(11,'2026-01-01T00:00:00Z'),(12,'2026-01-01T00:00:00Z'),(13,'2026-01-01T00:00:00Z'),(14,'2026-01-01T00:00:00Z') ON CONFLICT (version) DO NOTHING;")
  .replace(/INSERT INTO control_migrations\(version,applied_at\)[\s\S]*?ON CONFLICT \(version\) DO NOTHING;/u,
    "INSERT INTO control_migrations(version,applied_at) VALUES (1,'2026-01-01T00:00:00Z'),(2,'2026-01-01T00:00:00Z'),(3,'2026-01-01T00:00:00Z'),(4,'2026-01-01T00:00:00Z'),(5,'2026-01-01T00:00:00Z'),(6,'2026-01-01T00:00:00Z'),(7,'2026-01-01T00:00:00Z'),(8,'2026-01-01T00:00:00Z'),(9,'2026-01-01T00:00:00Z'),(10,'2026-01-01T00:00:00Z'),(11,'2026-01-01T00:00:00Z'),(12,'2026-01-01T00:00:00Z'),(13,'2026-01-01T00:00:00Z'),(14,'2026-01-01T00:00:00Z'),(15,'2026-01-01T00:00:00Z'),(16,'2026-01-01T00:00:00Z'),(17,'2026-01-01T00:00:00Z'),(18,'2026-01-01T00:00:00Z') ON CONFLICT (version) DO NOTHING;");

export const openTestDatabase = (..._legacyArguments) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerOperator({
    operator: '~', left: DataType.text, right: DataType.text, returns: DataType.bool,
    implementation: (value, pattern) => new RegExp(pattern, 'u').test(value)
  });
  memory.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value) => value.length });
  memory.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'address_test' });
  memory.public.registerFunction({ name: 'pg_database_size', args: [DataType.text], returns: DataType.integer, implementation: () => 0 });
  memory.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value) => value.trim() });
  memory.public.registerFunction({
    name: 'replace', args: [DataType.text, DataType.text, DataType.text], returns: DataType.text,
    implementation: (value, search, replacement) => value.split(search).join(replacement)
  });
  memory.public.registerFunction({
    name: 'nullif', args: [DataType.text, DataType.text], returns: DataType.text,
    implementation: (left, right) => left === right ? null : left
  });
  memory.public.registerFunction({
    name: 'substr', args: [DataType.text, DataType.integer, DataType.integer], returns: DataType.text,
    implementation: (value, start, length) => value.slice(start - 1, start - 1 + length)
  });
  memory.public.registerFunction({
    name: 'safe_timestamp', args: [DataType.text], returns: DataType.timestamp,
    implementation: (value) => Number.isNaN(Date.parse(value)) ? null : new Date(value)
  });
  memory.public.registerFunction({
    name: 'test_hex', args: [DataType.text], returns: DataType.text,
    implementation: (value) => Buffer.from(value, 'utf8').toString('hex').toUpperCase()
  });
  memory.public.registerFunction({
    name: 'test_regex', args: [DataType.text, DataType.text], returns: DataType.bool,
    implementation: (value, pattern) => new RegExp(pattern, 'u').test(value)
  });
  for (const statement of testSchema(addressSource).split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim()).filter(Boolean)) {
    memory.public.none(statement);
  }
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const query = pool.query.bind(pool);
  pool.query = (source, values) => query(String(source)
    .replace(/CREATE TEMP TABLE/giu, 'CREATE TABLE')
    .replace(/encode\(convert_to\(([^,()]+),'UTF8'\),'hex'\)/giu, 'test_hex($1)')
    .replace(/([a-z_][a-z0-9_.]*)\s+~\s+'\^\[0-9\][^']*'/giu, 'safe_timestamp($1) IS NOT NULL')
    .replace(/([a-z_][a-z0-9_.]*)\s+!~\s+'([^']+)'/giu, "NOT test_regex($1,'$2')")
    .replace(/([a-z_][a-z0-9_.]*)\s+~\s+'([^']+)'/giu, "test_regex($1,'$2')")
    .replace(/([a-z_][a-z0-9_.]*)::timestamptz/giu, 'safe_timestamp($1)')
    .replace(/(\$\d+)::timestamptz/gu, (_match, parameter) => `safe_timestamp(${parameter})`), values);
  const database = new PostgresDatabase(pool, { ownsPool: true });
  initialized.set(database, new Set([fileURLToPath(addressSchema)]));
  return database;
};

export const initializeTestDatabase = async (database, schema = addressSchema) => {
  const path = schema instanceof URL ? fileURLToPath(schema) : schema;
  const schemas = initialized.get(database) || new Set();
  if (schemas.has(path)) return;
  const source = await readFile(path, 'utf8');
  for (const statement of testSchema(source).split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim()).filter(Boolean)) {
    await database.exec(statement);
  }
  schemas.add(path);
  initialized.set(database, schemas);
};

export { PostgresDatabase } from '../../server/database/postgres.mjs';
