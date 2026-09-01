import type { CountryCode, VerifiedAddress } from '../../../src/domain/types';
import type { AddressFilters, CatalogTarget } from '../repositories/address-repository';
import type { RandomAddressSource } from './random-address-index';

export interface RandomAddressPickInput {
  countryCode: CountryCode;
  filters: AddressFilters;
  target?: CatalogTarget;
  seed: string;
}

export interface RandomAddressPick {
  address: VerifiedAddress;
  source: RandomAddressSource;
  eligibleCount: number;
}

export type RandomAddressPickState =
  | { ready: false }
  | { ready: true; result?: RandomAddressPick };

export interface RandomAddressService {
  pick(input: RandomAddressPickInput): Promise<RandomAddressPickState>;
}
