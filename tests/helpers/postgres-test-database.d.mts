import type { PostgresDatabase } from '../../server/database/postgres.mjs';

export const openTestDatabase: (...legacyArguments: unknown[]) => PostgresDatabase;
export const initializeTestDatabase: (database: PostgresDatabase, schema?: URL | string) => Promise<void>;
export { PostgresDatabase } from '../../server/database/postgres.mjs';
