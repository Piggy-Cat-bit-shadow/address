import type { AddressComponents, CountryCode } from './types';
export declare const addressContracts: Record<string, { code: CountryCode; required: readonly string[]; adminCode: boolean }>;
export declare const requiresAdminCode: (countryCode: CountryCode) => boolean;
export declare function validateNativeScript(countryCode: CountryCode, value: unknown, options?: { strict?: boolean }): boolean;
export declare function validateAddressContract(countryCode: CountryCode, components?: Partial<AddressComponents>, options?: { strict?: boolean; requireAdminCode?: boolean }): { valid: boolean; reasons: string[] };
