import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

const { Pool } = pg;
const addressSchemaUrl = new URL('./schema.sql', import.meta.url);
const controlSchemaUrl = new URL('../control/schema.sql', import.meta.url);
const ADDRESS_SCHEMA_VERSION = 17;
const CONTROL_SCHEMA_VERSION = 18;

const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

export const postgresPoolOptions = (environment = process.env) => ({
  connectionString: environment.POSTGRES_URL || environment.DATABASE_URL,
  max: integer(environment.POSTGRES_POOL_MAX, 64, 1, 512),
  min: integer(environment.POSTGRES_POOL_MIN, 4, 0, 128),
  connectionTimeoutMillis: integer(environment.POSTGRES_CONNECT_TIMEOUT_MS, 10_000, 1_000, 120_000),
  idleTimeoutMillis: integer(environment.POSTGRES_IDLE_TIMEOUT_MS, 30_000, 1_000, 30 * 60_000),
  statement_timeout: integer(environment.POSTGRES_STATEMENT_TIMEOUT_MS, 30_000, 1_000, 30 * 60_000),
  application_name: environment.POSTGRES_APPLICATION_NAME || 'address',
  options: environment.POSTGRES_OPTIONS || '-c search_path=address,control,public'
});

export const createPostgresPool = (options = {}) => {
  const { environment, ...overrides } = options;
  const pool = new Pool({ ...postgresPoolOptions(environment), ...overrides });
  return pool;
};

export const initializePostgres = async (pool, {
  addressSchema = addressSchemaUrl,
  controlSchema = controlSchemaUrl
} = {}) => {
  const [addressSource, controlSource] = await Promise.all([
    readFile(addressSchema instanceof URL ? fileURLToPath(addressSchema) : addressSchema, 'utf8'),
    readFile(controlSchema instanceof URL ? fileURLToPath(controlSchema) : controlSchema, 'utf8')
  ]);
  const client = await pool.connect();
  try {
    try {
      const { rows: [versions] } = await client.query(`
        SELECT
          (SELECT COALESCE(MAX(version), 0) FROM address.schema_migrations) AS address_version,
          (SELECT COALESCE(MAX(version), 0) FROM control.control_migrations) AS control_version
      `);
      if (Number(versions.address_version) >= ADDRESS_SCHEMA_VERSION
        && Number(versions.control_version) >= CONTROL_SCHEMA_VERSION) return;
    } catch (error) {
      if (!['3F000', '42P01'].includes(error?.code)) throw error;
    }
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout TO '30min'");
    await client.query("SET LOCAL lock_timeout TO '5min'");
    await client.query('CREATE SCHEMA IF NOT EXISTS address');
    await client.query('CREATE SCHEMA IF NOT EXISTS control');
    await client.query('SET LOCAL search_path TO address, public');
    await client.query(addressSource);
    await client.query('SET LOCAL search_path TO control, public');
    await client.query(controlSource);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const rewritePlaceholders = (source) => {
  let output = '';
  let quote = '';
  let parameter = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      output += character;
      if (character === quote) {
        if (source[index + 1] === quote) output += source[++index];
        else quote = '';
      }
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      output += character;
    } else if (character === '?') {
      output += `$${++parameter}`;
    } else output += character;
  }
  return output;
};

class PostgresPreparedStatement {
  constructor(database, query, bindings = []) {
    this.database = database;
    this.query = rewritePlaceholders(String(query));
    this.bindings = bindings;
  }

  bind(...values) {
    return new PostgresPreparedStatement(this.database, this.query, values);
  }

  async all() {
    const startedAt = performance.now();
    const result = await this.database.query(this.query, this.bindings);
    return {
      success: true,
      results: result.rows,
      meta: {
        duration: performance.now() - startedAt,
        changes: result.rowCount || 0,
        last_row_id: 0,
        rows_read: result.rows.length,
        rows_written: 0
      }
    };
  }

  async first(columnName) {
    const result = await this.database.query(this.query, this.bindings);
    const row = result.rows[0] || null;
    return row && columnName !== undefined ? row[columnName] ?? null : row;
  }

  async run() {
    const startedAt = performance.now();
    const result = await this.database.query(this.query, this.bindings);
    return {
      success: true,
      results: result.rows,
      meta: {
        duration: performance.now() - startedAt,
        changes: result.rowCount || 0,
        last_row_id: 0,
        rows_read: result.rows.length,
        rows_written: result.rowCount || 0
      }
    };
  }

  async raw(options = {}) {
    const result = await this.database.query(this.query, this.bindings);
    const columns = result.fields.map(({ name }) => name);
    const rows = result.rows.map((row) => columns.map((column) => row[column]));
    return options.columnNames ? [columns, ...rows] : rows;
  }
}

export class PostgresDatabase {
  constructor(pool, { ownsPool = false } = {}) {
    this.pool = pool;
    this.ownsPool = ownsPool;
    this.dialect = 'postgres';
    this.transactions = new AsyncLocalStorage();
    this.activeTransactions = new Set();
    this.transactionClient = null;
  }

  prepare(query) {
    return new PostgresPreparedStatement(this, query);
  }

  query(query, bindings) {
    const transaction = this.transactions.getStore();
    return (transaction?.active ? transaction.client : this.transactionClient || this.pool).query(query, bindings);
  }

  async batch(statements) {
    const transaction = this.transactions.getStore();
    if (transaction?.active) {
      const database = new PostgresDatabase(transaction.client);
      const results = [];
      for (const statement of statements) {
        results.push(await new PostgresPreparedStatement(
          database, statement.query, statement.bindings
        ).run());
      }
      return results;
    }
    if (this.transactionClient) {
      const database = new PostgresDatabase(this.transactionClient);
      const results = [];
      for (const statement of statements) {
        results.push(await new PostgresPreparedStatement(
          database, statement.query, statement.bindings
        ).run());
      }
      return results;
    }
    const client = await this.pool.connect();
    const database = new PostgresDatabase(client);
    try {
      await client.query('BEGIN');
      const results = [];
      for (const statement of statements) {
        results.push(await new PostgresPreparedStatement(
          database, statement.query, statement.bindings
        ).run());
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(query) {
    const startedAt = performance.now();
    const normalized = String(query).trim();
    if (!normalized) return { count: 0, duration: performance.now() - startedAt };
    if (/^BEGIN\s*;?$/iu.test(normalized)) {
      if (this.transactions.getStore()?.active || this.transactionClient) throw new Error('PostgreSQL transaction is already active');
      this.transactionClient = await this.pool.connect();
      await this.transactionClient.query('BEGIN');
      return { count: 0, duration: performance.now() - startedAt };
    }
    if (/^(COMMIT|ROLLBACK)\s*;?$/iu.test(normalized) && this.transactionClient) {
      const client = this.transactionClient;
      this.transactionClient = null;
      try { await client.query(normalized.replace(/;$/u, '')); }
      finally { client.release(); }
      return { count: 0, duration: performance.now() - startedAt };
    }
    const result = await this.query(normalized);
    return { count: result.rowCount || 0, duration: performance.now() - startedAt };
  }

  async transaction(work) {
    if (this.transactions.getStore()?.active || this.transactionClient) {
      throw new Error('PostgreSQL transaction is already active');
    }
    const client = await this.pool.connect();
    const transaction = { client, active: true };
    this.activeTransactions.add(transaction);
    try {
      await client.query('BEGIN');
      return await this.transactions.run(transaction, async () => {
        try {
          const result = await work(this);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
    } finally {
      transaction.active = false;
      this.activeTransactions.delete(transaction);
      client.release();
    }
  }

  close() {
    const legacyClient = this.transactionClient;
    const legacyRollback = legacyClient
      ? legacyClient.query('ROLLBACK').finally(() => legacyClient.release())
      : Promise.resolve();
    this.transactionClient = null;
    const rollbacks = [...this.activeTransactions].map(async (transaction) => {
      transaction.active = false;
      try { await transaction.client.query('ROLLBACK'); }
      finally { transaction.client.release(); }
    });
    this.activeTransactions.clear();
    return Promise.allSettled([legacyRollback, ...rollbacks]).then(() => this.ownsPool ? this.pool.end() : undefined);
  }
}

export const openPostgresDatabase = async (options = {}) => {
  const pool = options.pool || createPostgresPool(options);
  if (options.migrate !== false) await initializePostgres(pool, options);
  return new PostgresDatabase(pool, { ownsPool: !options.pool });
};
