import type { Database } from '../database/database.mjs';

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
  minPerNode: number;
  coverageRatio: number;
  level1Min: number;
  level2Min: number;
  labels: string[];
  [key: string]: unknown;
}

export function getRuntimePolicy(database: Database): Promise<RuntimePolicy>;
export function updateRuntimePolicy(database: Database, input: Record<string, unknown>): Promise<RuntimePolicy>;
export function listCountryPolicies(database: Database): Promise<CountryPolicy[]>;
export function getCountryPolicy(database: Database, countryCode: string): Promise<CountryPolicy>;
export function updateCountryPolicy(database: Database, countryCode: string, input: Record<string, unknown>): Promise<CountryPolicy>;
export function listNodePolicies(database: Database, parentKey: string): Promise<Array<Record<string, unknown>>>;
export function upsertNodePolicy(database: Database, nodeKey: string, targetCount?: number): Promise<Record<string, unknown>>;
export function deleteNodePolicy(database: Database, nodeKey: string): Promise<void>;

export interface NodeTargetPolicy {
  key: string;
  parentKey: string;
  countryCode: string;
  level: number;
  regionCode: string;
  regionName: string;
  currentCount: number;
  defaultTarget: number;
  overrideTarget: number | null;
  targetCount: number;
  satisfied: boolean;
  deficit: number;
  excess: number;
  updatedAt: string;
}

export const CHINA_NODE_TARGET_SEEDS: Record<string, number>;
export function ensureAddressPolicies(database: Database, now?: string): Promise<void>;
export function listCountryNodeTargets(database: Database, countryCode: string): Promise<NodeTargetPolicy[]>;
export function upsertNodeTarget(database: Database, nodeKey: string, minCount?: number): Promise<{ key: string; minCount: number; updatedAt: string }>;
export function deleteNodeTarget(database: Database, nodeKey: string): Promise<void>;
