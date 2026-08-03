import { describe, expect, it } from 'vitest';
import { countries } from '../src/domain/countries';
import type { CountryCode } from '../src/domain/types';
import {
  RandomAddressIndex,
  type RandomAddressIndexRow
} from '../server/api/services/random-address-index';

const row = (
  addressId: string,
  countryCode: CountryCode = 'US',
  overrides: Partial<RandomAddressIndexRow> = {}
): RandomAddressIndexRow => ({
  addressId,
  countryCode,
  source: countryCode === 'CN' ? 'china-map-community' : 'address-pool-v2',
  regionValues: ['California', 'CA'],
  cityValues: ['Los Angeles'],
  districtValues: ['Hollywood'],
  postcodeValues: ['90028'],
  searchText: `${addressId} Sunset Boulevard Los Angeles California 90028`,
  ...overrides
});

describe('unified random address index', () => {
  it('selects reproducibly from the complete country candidate range', () => {
    const rows = Array.from({ length: 257 }, (_, index) => row(`address-${index}`));
    const index = new RandomAddressIndex(rows);
    const reached = new Set<string>();

    for (let seed = 0; seed < 20_000 && reached.size < rows.length; seed += 1) {
      reached.add(index.select('US', {}, undefined, `seed-${seed}`)!.reference.addressId);
    }

    expect(reached.size).toBe(rows.length);
    expect(index.select('US', {}, undefined, 'repeatable')).toEqual(
      index.select('US', {}, undefined, 'repeatable')
    );
  });

  it('intersects region, city, district, postcode and text filters exactly', () => {
    const matching = row('matching', 'CN', {
      regionValues: ['河北省'],
      cityValues: ['保定市'],
      districtValues: ['定兴县'],
      postcodeValues: ['072650'],
      searchText: '河北省 保定市 定兴县 昌盛大街 水榭康都'
    });
    const index = new RandomAddressIndex([
      matching,
      row('wrong-city', 'CN', { regionValues: ['河北省'], cityValues: ['唐山市'], districtValues: ['乐亭县'] }),
      row('wrong-region', 'CN', { regionValues: ['北京市'], cityValues: ['北京市'], districtValues: ['怀柔区'] })
    ]);

    expect(index.candidates('CN', {
      region: '河北', city: '保定', district: '定兴', postcode: '072 650', q: '昌盛 水榭'
    })).toEqual([expect.objectContaining({ addressId: 'matching' })]);
    expect(index.candidates('CN', { region: '河北省', city: '北京市' })).toEqual([]);
  });

  it('uses the same selector for every supported country', () => {
    const rows = countries.flatMap(({ code }) => [row(`${code}-a`, code), row(`${code}-b`, code)]);
    const index = new RandomAddressIndex(rows);

    expect(index.counts()).toEqual(Object.fromEntries(countries.map(({ code }) => [code, 2])));
    for (const { code } of countries) {
      const ids = new Set(Array.from({ length: 128 }, (_, seed) =>
        index.select(code, {}, undefined, `${code}-${seed}`)?.reference.addressId
      ));
      expect(ids, code).toEqual(new Set([`${code}-a`, `${code}-b`]));
    }
  });

  it('honors catalog aliases without broadening the selected scope', () => {
    const index = new RandomAddressIndex([
      row('alias-match', 'US', { regionValues: ['California', 'CA'], cityValues: ['Los Angeles', 'LA'] }),
      row('other', 'US', { regionValues: ['New York', 'NY'], cityValues: ['New York City', 'NYC'] })
    ]);
    const candidates = index.candidates('US', {}, {
      coordinates: { latitude: 34.05, longitude: -118.24 },
      region: 'California',
      regionCode: 'US-CA',
      regionAliases: ['CA'],
      city: 'Los Angeles',
      cityAliases: ['LA'],
      bucket: 'los-angeles'
    });

    expect(candidates.map(({ addressId }) => addressId)).toEqual(['alias-match']);
  });
});
