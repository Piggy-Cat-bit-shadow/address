import {
  createPostgresPool, initializePostgres, PostgresDatabase
} from './postgres.mjs';

export interface RuntimeDatabases {
  driver: 'postgres';
  address: PostgresDatabase;
  control: PostgresDatabase;
  postgresUrl: string;
  close(): Promise<void>;
}

export const openRuntimeDatabases = async (
  environment: NodeJS.ProcessEnv = process.env
): Promise<RuntimeDatabases> => {
  if (environment.NODE_ENV === 'test' && environment.ADDRESS_TEST_DATABASE === 'memory') {
    const { initializeTestDatabase, openTestDatabase } = await import('../../tests/helpers/postgres-test-database.mjs');
    const { ensureAddressPolicies } = await import('../sync/address-policy.mjs');
    const database = openTestDatabase(':memory:') as PostgresDatabase;
    await initializeTestDatabase(database, new URL('../control/schema.sql', import.meta.url));
    await ensureAddressPolicies(database);
    return {
      driver: 'postgres',
      address: database,
      control: database,
      postgresUrl: 'postgresql://memory-test/address',
      close: async () => { database.close(); }
    };
  }
  const postgresUrl = environment.POSTGRES_URL || environment.DATABASE_URL;
  if (!postgresUrl) throw new Error('POSTGRES_URL or DATABASE_URL is required');
  const pool = createPostgresPool({ environment });
  await initializePostgres(pool);
  return {
    driver: 'postgres',
    address: new PostgresDatabase(pool),
    control: new PostgresDatabase(pool),
    postgresUrl,
    close: () => pool.end()
  };
};
