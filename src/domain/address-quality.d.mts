export interface AddressQualityResult<T extends object> {
  valid: boolean;
  reasons: string[];
  components: T;
}

export const countryAddressPolicies: Readonly<Record<string, Readonly<{
  admin1?: boolean;
  locality?: boolean;
  district?: boolean;
  postcode?: boolean;
}>>>;
export function normalizePostcode(countryCode: string, value: unknown): string;
export function normalizeAddressFacts<T extends object>(countryCode: string, input?: T): T;
export function validateAddressQuality<T extends object>(input?: {
  countryCode?: string;
  components?: T;
  latitude?: unknown;
  longitude?: unknown;
}): AddressQualityResult<T>;
export function addressQualitySqlClause(prefix?: string): string;
