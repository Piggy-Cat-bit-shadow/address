import { describe, expect, it } from 'vitest';
import { requiresAdminCode, validateAddressContract, validateNativeScript } from '../src/domain/address-contracts.mjs';

describe('country address contracts', () => {
  it('limits postal administrative codes to the six postal-code systems', () => {
    for (const code of ['US', 'CA', 'AU', 'BR', 'MX', 'IT']) expect(requiresAdminCode(code)).toBe(true);
    for (const code of ['DE', 'JP', 'HK', 'TW', 'IN', 'SA']) expect(requiresAdminCode(code)).toBe(false);
  });

  it('rejects incomplete contract fields and accepts a complete record', () => {
    const complete = { houseNumber: '10', street: 'Main Street', admin1: 'California', locality: 'Los Angeles', postcode: '90001', admin1Code: 'CA' };
    expect(validateAddressContract('US', complete, { strict: true }).valid).toBe(true);
    expect(validateAddressContract('US', { ...complete, locality: '' }).reasons).toContain('missing_locality');
  });

  it('enforces native scripts only in strict import mode', () => {
    expect(validateNativeScript('HK', '九龍', { strict: true })).toBe(true);
    expect(validateNativeScript('HK', 'Kowloon', { strict: true })).toBe(false);
    expect(validateNativeScript('HK', 'Kowloon')).toBe(true);
    expect(validateNativeScript('SA', 'الرياض', { strict: true })).toBe(true);
  });

  it('rejects mixed Latin administrative text for traditional Chinese native records', () => {
    const components = {
      houseNumber: '10', street: '皇后大道 Queen\'s Road', admin1: '香港島', locality: '中西區', postcode: ''
    };
    expect(validateAddressContract('HK', components, { strict: true }).reasons).toContain('native_mixed_latin');
    expect(validateAddressContract('HK', { ...components, street: '皇后大道' }, { strict: true }).valid).toBe(true);
  });

  it('requires a Han native semantic field for Taiwan', () => {
    const components = { houseNumber: '10', street: 'Zhongxiao East Road', admin1: '臺北市', locality: '中正區', postcode: '100001' };
    expect(validateAddressContract('TW', components, { strict: true }).reasons).toContain('native_mixed_latin');
  });

  it('checks every native core field while allowing an international building name', () => {
    const thai = {
      houseNumber: '25', street: 'ถนนสาทร', buildingName: 'Ariel Apartments', admin1: 'กรุงเทพมหานคร',
      locality: 'สาทร', district: 'ยานนาวา', postcode: '10120'
    };
    expect(validateAddressContract('TH', thai, { strict: true }).valid).toBe(true);
    expect(validateAddressContract('TH', { ...thai, street: 'Thong Lor Soi 13' }, { strict: true }).reasons)
      .toContain('invalid_native_script');
    expect(validateAddressContract('TH', { ...thai, locality: 'Muang Uthai Thani' }, { strict: true }).reasons)
      .toContain('invalid_native_script');
    expect(validateAddressContract('TH', { ...thai, street: 'ถนน Sathorn' }, { strict: true }).reasons)
      .toContain('native_mixed_latin');
  });

  it('can defer the administrative code check until catalog enrichment', () => {
    const mexico = { houseNumber: '10', street: 'Avenida Reforma', admin1: 'Ciudad de Mexico', locality: 'Cuauhtemoc', district: 'Juarez', postcode: '06600' };
    expect(validateAddressContract('MX', mexico, { strict: true }).reasons).toContain('missing_admin1_code');
    expect(validateAddressContract('MX', mexico, { strict: true, requireAdminCode: false }).valid).toBe(true);
  });

  it('allows alphanumeric building identifiers in otherwise native text', () => {
    const china = { houseNumber: '12', street: '星博国际D1-12号', admin1: '贵州省', locality: '安顺市', district: '普定县', postcode: '' };
    expect(validateAddressContract('CN', china, { strict: true }).valid).toBe(true);
    expect(validateAddressContract('CN', { ...china, street: '工农路888号万达悦府B区13号楼' }, { strict: true }).valid).toBe(true);
    expect(validateAddressContract('CN', { ...china, street: 'Xingbo International' }, { strict: true }).valid).toBe(false);
  });
});
