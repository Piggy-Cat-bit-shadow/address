import type { Database } from '../database/database.mjs';

export interface CountryGoalLevel {
  level: number;
  minimum: number;
  total: number;
  covered: number;
  qualified: number;
  coverageRatio: number | null;
  floorRatio: number | null;
}

export interface CountryGoalRules {
  total: { current: number; target: number; met: boolean };
  administrativeCoverage: {
    actual: number; target: number; met: boolean; covered: number; total: number;
  };
  regionalMinimums: {
    actual: number; target: number; met: boolean;
    lowest: CountryGoalLevel | null;
    level1: CountryGoalLevel | null;
    level2: CountryGoalLevel | null;
    overrides: { satisfied: number; total: number; met: boolean };
  };
}

export interface CountryGoalEvaluation {
  countryCode: string;
  enabled: boolean;
  current: number;
  target: number;
  deficit: number;
  countMet: boolean;
  coverageMet: boolean;
  overrideMet: boolean;
  complete: boolean;
  unmetRules: string[];
  coverageRatio: number;
  coverageActual: number;
  lowest: CountryGoalLevel | null;
  level1: CountryGoalLevel | null;
  level2: CountryGoalLevel | null;
  rules: CountryGoalRules;
}

export function eligibleCoverageNode(row: Record<string, unknown>): boolean;
export function evaluateCountryGoals(database: Database): Promise<Map<string, CountryGoalEvaluation>>;
