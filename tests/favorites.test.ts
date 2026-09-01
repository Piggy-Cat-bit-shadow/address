import { favoriteFromBundle, favoriteIdFor, isFavoriteAddress, moveFavoriteWithinCountry, safeExternalUrl } from '../src/domain/favorites';
import type { CountryCode, GeneratedBundle } from '../src/domain/types';
import { describe, expect, it } from 'vitest';

const bundle = (countryCode: CountryCode, id: string, unit = ''): GeneratedBundle => ({
  id: `bundle-${id}`, seed: 'seed', generatedAt: '2026-08-04T00:00:00.000Z', residential: true,
  profile: { fullName: 'Must Not Persist', gender: 'unspecified', email: 'private@example.test', phone: '0', dateOfBirth: '2000-01-01' },
  extensions: {} as GeneratedBundle['extensions'], card: {} as GeneratedBundle['card'],
  address: {
    id, countryCode, nativeAddress: 'Native address', formattedAddress: 'Example address', nativeLanguage: 'en',
    addressVariants: { native: 'Native address', en: 'Example address', 'zh-CN': '示例地址' },
    components: { houseNumber: '20', street: 'Example Street', locality: 'Example City', postcode: '10000' },
    componentVariants: {
      native: { houseNumber: '20', street: 'Example Street', locality: 'Example City', postcode: '10000' },
      en: { houseNumber: '20', street: 'Example Street', locality: 'Example City', postcode: '10000' },
      'zh-CN': { houseNumber: '20', street: '示例街道', locality: '示例城市', postcode: '10000' }
    },
    coordinates: { latitude: 1, longitude: 2 }, addressStatus: 'verified', propertyType: 'residential', unitStatus: 'not_present',
    matchLevel: 'premise', verificationLevel: 'L2', sourceVersion: 'v1', sourceUpdatedAt: '2026-08-04', verifiedAt: '2026-08-04', expiresAt: '2027-08-04', evidence: [], exclusionFlags: []
  },
  addressFormats: {
    native: { language: 'native', postalLines: ['Native address'], singleLine: 'Native address' },
    en: { language: 'en', postalLines: ['Example address'], singleLine: 'Example address' },
    'zh-CN': { language: 'zh-CN', postalLines: ['示例地址'], singleLine: '示例地址' }
  },
  ...(unit ? { generatedUnit: { components: { building: '', unit, room: '' }, variants: { native: unit, en: unit, 'zh-CN': unit }, provenance: 'synthetic', unitProvenance: 'synthetic' } } : {}),
  googleMaps: { status: 'map_query', embedUrl: 'https://maps.example/embed', openUrl: 'https://maps.example/open' }
});

describe('address favorites', () => {
  it('stores only the address snapshot and distinguishes generated units', () => {
    const source = bundle('US', 'address-1', '2A');
    const favorite = favoriteFromBundle(source, 1, new Date('2026-08-04T00:00:00.000Z'));
    expect(isFavoriteAddress(favorite)).toBe(true);
    expect(favoriteIdFor(source)).toBe('address-1:2A');
    expect(JSON.stringify(favorite)).not.toContain('Must Not Persist');
    expect(JSON.stringify(favorite)).not.toContain('private@example.test');
  });

  it('moves entries only within their country and normalizes positions', () => {
    const values = [
      favoriteFromBundle(bundle('US', 'us-1'), 1), favoriteFromBundle(bundle('US', 'us-2'), 2),
      favoriteFromBundle(bundle('CA', 'ca-1'), 1)
    ];
    const moved = moveFavoriteWithinCountry(values, 'us-2', 1);
    expect(moved.filter(({ countryCode }) => countryCode === 'US').sort((a, b) => a.position - b.position).map(({ id }) => id)).toEqual(['us-2', 'us-1']);
    expect(moved.find(({ id }) => id === 'ca-1')?.position).toBe(1);
  });

  it('allows only HTTP map links', () => {
    expect(safeExternalUrl('https://maps.example/path')).toBe('https://maps.example/path');
    expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeExternalUrl('not a URL')).toBeUndefined();
  });
});
