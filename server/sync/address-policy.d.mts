import type { SqliteDatabase } from '../database/sqlite.mjs';

export interface RuntimePolicy {
  prepareConcurrency: number;
  cpuConcurrency: number;
  updatedAt?: string;
}

export interface CountryPolicy {
  countryCode: string;
  enabled: boolean;
  targetCount: number;
  level1Limit: number;
  level2Limit: number;
  level3Limit: number;
  level4Limit: number;
  labels: string[];
  [key: string]: unknown;
}

export function getRuntimePolicy(database: SqliteDatabase): Promise<RuntimePolicy>;
export function updateRuntimePolicy(database: SqliteDatabase, input: Record<string, unknown>): Promise<RuntimePolicy>;
export function listCountryPolicies(database: SqliteDatabase): Promise<CountryPolicy[]>;
export function getCountryPolicy(database: SqliteDatabase, countryCode: string): Promise<CountryPolicy>;
export function updateCountryPolicy(database: SqliteDatabase, countryCode: string, input: Record<string, unknown>): Promise<CountryPolicy>;
export function listNodePolicies(database: SqliteDatabase, parentKey: string): Promise<Array<Record<string, unknown>>>;
export function upsertNodePolicy(database: SqliteDatabase, nodeKey: string, targetCount?: number): Promise<Record<string, unknown>>;
export function deleteNodePolicy(database: SqliteDatabase, nodeKey: string): Promise<void>;
