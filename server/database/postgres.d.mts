import type { Pool, PoolConfig, QueryResult } from 'pg';
import type { Database } from './database.mjs';

export interface PostgresEnvironment extends NodeJS.ProcessEnv {
  POSTGRES_URL?: string;
  DATABASE_URL?: string;
  POSTGRES_POOL_MAX?: string;
  POSTGRES_POOL_MIN?: string;
}

export declare const postgresPoolOptions: (environment?: PostgresEnvironment) => PoolConfig;
export declare const createPostgresPool: (options?: PoolConfig & { environment?: PostgresEnvironment }) => Pool;
export declare const initializePostgres: (pool: Pool, options?: {
  addressSchema?: string | URL;
  controlSchema?: string | URL;
}) => Promise<void>;

export declare class PostgresDatabase implements Database {
  constructor(pool: Pool, options?: { ownsPool?: boolean });
  pool: Pool;
  dialect: 'postgres';
  prepare: Database['prepare'];
  batch: Database['batch'];
  exec: Database['exec'];
  transaction: Database['transaction'];
  query(query: string, bindings?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}

export declare const openPostgresDatabase: (options?: PoolConfig & {
  pool?: Pool;
  migrate?: boolean;
  environment?: PostgresEnvironment;
  addressSchema?: string | URL;
  controlSchema?: string | URL;
}) => Promise<PostgresDatabase>;
