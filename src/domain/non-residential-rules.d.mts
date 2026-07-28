export interface NonResidentialRule {
  classifications: string[];
  terms: Record<string, string[]>;
}

export const countryLanguages: Readonly<Record<string, string[]>>;
export const nonResidentialRules: Readonly<Record<string, NonResidentialRule>>;
