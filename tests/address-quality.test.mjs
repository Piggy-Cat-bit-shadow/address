import { describe, expect, it } from 'vitest';
import {
  addressQualitySqlClause,
  countryAddressPolicies,
  normalizeAddressFacts,
  normalizePostcode,
  validateAddressQuality
} from '../src/domain/address-quality.mjs';

const base = {
  houseNumber: '12', street: 'Main Street', locality: 'Example City', district: 'Central',
  admin1: 'Example State', postcode: '12345'
};
const validPostcodes = {
  US: '19103', CA: 'K1A 0B1', MX: '01000', GB: 'SW1A 1AA', DE: '10115', FR: '75001',
  IT: '00118', ES: '28001', NL: '1012 AB', JP: '100-0001', CN: '', HK: '', TW: '100',
  KR: '03001', SG: '018989', MY: '50000', TH: '10110', PH: '1000', VN: '100000',
  TR: '34000', SA: '12345', IN: '110001', AU: '2000', BR: '01001-000', NG: '100001',
  ZA: '8001', RU: '101000'
};

describe('country address quality gate', () => {
  it.each(Object.entries(countryAddressPolicies))('enforces every declared field for %s', (countryCode, policy) => {
    const components = { ...base, postcode: validPostcodes[countryCode] };
    expect(validateAddressQuality({ countryCode, components }).valid).toBe(true);
    const required = {
      admin1: ['admin1', 'missing_admin1'], locality: ['locality', 'missing_locality'],
      district: ['district', 'missing_district'], postcode: ['postcode', 'missing_postcode']
    };
    for (const [rule, [field, reason]] of Object.entries(required)) {
      if (!policy[rule]) continue;
      const missing = { ...components, [field]: '' };
      if (field === 'locality') missing.postalLocality = '';
      expect(validateAddressQuality({ countryCode, components: missing }).reasons).toContain(reason);
    }
  });

  it.each([
    ['DE', { ...base, admin1: '', district: '', postcode: '' }, 'missing_postcode'],
    ['IN', { ...base, postcode: '' }, 'missing_postcode'],
    ['US', { ...base, postcode: '' }, 'missing_postcode'],
    ['DE', { ...base, admin1: '', district: '', postcode: 'ABCDE' }, 'invalid_postcode'],
    ['IN', { ...base, postcode: '012345' }, 'invalid_postcode'],
    ['US', { ...base, postcode: '1234' }, 'invalid_postcode']
  ])('rejects incomplete or malformed %s records', (countryCode, components, reason) => {
    expect(validateAddressQuality({ countryCode, components })).toMatchObject({ valid: false, reasons: expect.arrayContaining([reason]) });
  });

  it('accepts complete German, Indian and US records', () => {
    expect(validateAddressQuality({ countryCode: 'DE', components: { ...base, admin1: '', district: '', postcode: '10115' } }).valid).toBe(true);
    expect(validateAddressQuality({ countryCode: 'IN', components: { ...base, postcode: '110001' } }).valid).toBe(true);
    expect(validateAddressQuality({ countryCode: 'US', components: { ...base, district: '', postcode: '19103' } }).valid).toBe(true);
  });

  it('only performs deterministic postcode formatting', () => {
    expect(normalizePostcode('CA', 'k1a0b1')).toBe('K1A 0B1');
    expect(normalizePostcode('GB', 'sw1a1aa')).toBe('SW1A 1AA');
    expect(normalizePostcode('JP', '1000001')).toBe('100-0001');
    expect(normalizePostcode('BR', '01001000')).toBe('01001-000');
  });

  it('reclassifies legacy numeric building names as source units', () => {
    expect(normalizeAddressFacts('US', { ...base, buildingName: '3' })).toMatchObject({ unit: '3' });
    expect(normalizeAddressFacts('US', { ...base, buildingName: '3' })).not.toHaveProperty('buildingName');
  });

  it('requires postcode columns in the SQL read gate', () => {
    const clause = addressQualitySqlClause('pool.');
    expect(clause).toMatch(/pool\.country_code IN \([^)]*'US'[^)]*\)/u);
    expect(clause).toContain("trim(pool.postcode) <> ''");
    expect(clause).toContain("pool.country_code IN ('CN')");
  });
});
