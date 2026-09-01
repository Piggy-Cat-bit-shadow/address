import { createHash } from 'node:crypto';
import { Converter as createTraditionalizer } from 'opencc-js/cn2t';
import { Converter as createSimplifier } from 'opencc-js/t2cn';
import type { CountryCode } from '../../../src/domain/types';
import type { AddressFilters, CatalogTarget } from '../repositories/address-repository';

export type RandomAddressSource = 'address-pool-v2' | 'china-map-community';

export interface RandomAddressIndexRow {
  addressId: string;
  countryCode: CountryCode;
  source: RandomAddressSource;
  regionValues: string[];
  cityValues: string[];
  districtValues: string[];
  postcodeValues: string[];
  searchText: string;
}

export interface RandomAddressReference {
  addressId: string;
  countryCode: CountryCode;
  source: RandomAddressSource;
  regionKeys: string[];
  cityKeys: string[];
  districtKeys: string[];
  postcodeKeys: string[];
  searchText: string;
}

export interface RandomAddressSelection {
  reference: RandomAddressReference;
  candidateCount: number;
}

const toSimplifiedHan = createSimplifier({ from: 'hk', to: 'cn' });
const toTraditionalHan = createTraditionalizer({ from: 'cn', to: 'tw' });
const han = /\p{Script=Han}/u;
const adminSuffix = /(?:自治区|自治區|特别行政区|特別行政區|自治州|地区|省|市|縣|县|区|區|都|道|府|県)$/u;

export const normalizeGenerationValue = (value: string): string => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/gu, '')
  .toLocaleLowerCase('und')
  .replace(/\s+/gu, ' ')
  .trim();

const locationKeys = (values: string[], postcode = false): string[] => [...new Set(values.flatMap((raw) => {
  const normalized = normalizeGenerationValue(raw);
  if (!normalized) return [];
  if (postcode) return [normalized.replace(/\s/gu, '')];
  if (!han.test(normalized)) {
    const city = normalized.replace(/^city of\s+/u, '').replace(/\s+city$/u, '');
    return city && city !== normalized ? [normalized, city] : [normalized];
  }
  const variants = [...new Set([normalized, toSimplifiedHan(normalized), toTraditionalHan(normalized)])];
  return variants.flatMap((variant) => {
    const stem = variant.replace(adminSuffix, '');
    return stem && stem !== variant ? [variant, stem] : [variant];
  });
}))];

const intersects = (values: string[], expected: Set<string>): boolean => values.some((value) => expected.has(value));

interface CountryIndex {
  all: RandomAddressReference[];
  regions: Map<string, RandomAddressReference[]>;
  cities: Map<string, RandomAddressReference[]>;
  districts: Map<string, RandomAddressReference[]>;
  postcodes: Map<string, RandomAddressReference[]>;
  scopes: Map<string, RandomAddressReference[]>;
}

const emptyCountryIndex = (): CountryIndex => ({
  all: [], regions: new Map(), cities: new Map(), districts: new Map(), postcodes: new Map(), scopes: new Map()
});

const addToLookup = (
  lookup: Map<string, RandomAddressReference[]>,
  keys: string[],
  reference: RandomAddressReference
): void => {
  for (const key of keys) {
    const values = lookup.get(key);
    if (values) values.push(reference);
    else lookup.set(key, [reference]);
  }
};

const lookupUnion = (
  lookup: Map<string, RandomAddressReference[]>,
  keys: string[]
): RandomAddressReference[] => {
  if (keys.length === 1) return lookup.get(keys[0]) || [];
  const found = new Map<string, RandomAddressReference>();
  for (const key of keys) {
    for (const reference of lookup.get(key) || []) found.set(`${reference.source}:${reference.addressId}`, reference);
  }
  return [...found.values()];
};

const boundedScopeSet = (scopes: Map<string, RandomAddressReference[]>, key: string, values: RandomAddressReference[]): void => {
  scopes.delete(key);
  scopes.set(key, values);
  while (scopes.size > 500) scopes.delete(scopes.keys().next().value as string);
};

const deterministicIndex = (seed: string, scope: string, attempt: number, length: number): number => {
  const digest = createHash('sha256').update(`${scope}\u001f${seed}\u001f${attempt}`).digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(length));
};

export class RandomAddressIndex {
  private readonly countries = new Map<CountryCode, CountryIndex>();

  constructor(rows: RandomAddressIndexRow[] = []) {
    this.replace(rows);
  }

  replace(rows: RandomAddressIndexRow[]): void {
    this.countries.clear();
    for (const row of rows) {
      let country = this.countries.get(row.countryCode);
      if (!country) {
        country = emptyCountryIndex();
        this.countries.set(row.countryCode, country);
      }
      const reference: RandomAddressReference = {
        addressId: row.addressId,
        countryCode: row.countryCode,
        source: row.source,
        regionKeys: locationKeys(row.regionValues),
        cityKeys: locationKeys(row.cityValues),
        districtKeys: locationKeys(row.districtValues),
        postcodeKeys: locationKeys(row.postcodeValues, true),
        searchText: normalizeGenerationValue(row.searchText)
      };
      country.all.push(reference);
      addToLookup(country.regions, reference.regionKeys, reference);
      addToLookup(country.cities, reference.cityKeys, reference);
      addToLookup(country.districts, reference.districtKeys, reference);
      addToLookup(country.postcodes, reference.postcodeKeys, reference);
    }
  }

  counts(): Partial<Record<CountryCode, number>> {
    return Object.fromEntries([...this.countries].map(([country, index]) => [country, index.all.length]));
  }

  candidates(
    countryCode: CountryCode,
    filters: AddressFilters,
    target?: CatalogTarget
  ): RandomAddressReference[] {
    const country = this.countries.get(countryCode);
    if (!country) return [];
    const regionKeys = locationKeys([
      filters.region || '', target?.region || '', target?.regionNative || '', target?.regionCode || '',
      ...(target?.regionAliases || [])
    ]);
    const cityKeys = locationKeys([
      filters.city || '', target?.city || '', target?.cityNative || '', ...(target?.cityAliases || [])
    ]);
    const districtKeys = locationKeys([filters.district || '']);
    const postcodeKeys = locationKeys([filters.postcode || target?.postcode || ''], true);
    const queryTerms = normalizeGenerationValue(filters.q || '').split(' ').filter(Boolean);
    const requireRegion = Boolean(filters.region || filters.regionId || target?.region || target?.regionCode);
    const requireCity = Boolean(filters.city || filters.cityId || target?.city);
    const requireDistrict = Boolean(filters.district);
    const requirePostcode = Boolean(filters.postcode || filters.postcodeId || target?.postcode);
    if ((requireRegion && !regionKeys.length) || (requireCity && !cityKeys.length)
      || (requireDistrict && !districtKeys.length) || (requirePostcode && !postcodeKeys.length)) return [];

    const scopeKey = JSON.stringify([regionKeys, cityKeys, districtKeys, postcodeKeys, queryTerms]);
    const cached = country.scopes.get(scopeKey);
    if (cached) {
      country.scopes.delete(scopeKey);
      country.scopes.set(scopeKey, cached);
      return cached;
    }

    const bases: RandomAddressReference[][] = [];
    if (requireRegion) bases.push(lookupUnion(country.regions, regionKeys));
    if (requireCity) bases.push(lookupUnion(country.cities, cityKeys));
    if (requireDistrict) bases.push(lookupUnion(country.districts, districtKeys));
    if (requirePostcode) bases.push(lookupUnion(country.postcodes, postcodeKeys));
    if (bases.some((values) => values.length === 0)) {
      boundedScopeSet(country.scopes, scopeKey, []);
      return [];
    }
    const base = bases.length
      ? bases.reduce((smallest, values) => values.length < smallest.length ? values : smallest)
      : country.all;
    const regionSet = new Set(regionKeys);
    const citySet = new Set(cityKeys);
    const districtSet = new Set(districtKeys);
    const postcodeSet = new Set(postcodeKeys);
    const matched = base.filter((reference) =>
      (!requireRegion || intersects(reference.regionKeys, regionSet))
      && (!requireCity || intersects(reference.cityKeys, citySet))
      && (!requireDistrict || intersects(reference.districtKeys, districtSet))
      && (!requirePostcode || intersects(reference.postcodeKeys, postcodeSet))
      && queryTerms.every((term) => reference.searchText.includes(term))
    );
    boundedScopeSet(country.scopes, scopeKey, matched);
    return matched;
  }

  select(
    countryCode: CountryCode,
    filters: AddressFilters,
    target: CatalogTarget | undefined,
    seed: string,
    attempt = 0
  ): RandomAddressSelection | undefined {
    const candidates = this.candidates(countryCode, filters, target);
    if (!candidates.length) return undefined;
    const scope = JSON.stringify([countryCode, filters, target?.bucket || '']);
    return {
      reference: candidates[deterministicIndex(seed, scope, attempt, candidates.length)],
      candidateCount: candidates.length
    };
  }
}
