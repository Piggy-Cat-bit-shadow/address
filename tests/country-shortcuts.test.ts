import { describe, expect, it } from 'vitest';
import {
  countryShortcutDefaults, effectiveCountryShortcuts, strictCountryShortcutConfig
} from '../server/control/country-shortcuts';

describe('country shortcut configuration', () => {
  it('provides useful defaults for every supported country', () => {
    const values = countryShortcutDefaults();
    expect(Object.keys(values)).toHaveLength(27);
    for (const value of Object.values(values)) {
      expect(value.adminShortcuts.length).toBeGreaterThan(0);
      expect(value.popularCities.length).toBeGreaterThanOrEqual(6);
    }
    for (const code of ['US', 'CN', 'CA', 'GB', 'DE', 'FR', 'IT', 'ES', 'RU', 'JP', 'IN', 'AU', 'BR']) {
      expect(values[code as keyof typeof values].popularCities.length).toBeGreaterThanOrEqual(8);
    }
    expect(values.US.specialAreaTitle).toEqual({ en: 'States without statewide sales tax', 'zh-CN': '无州级销售税州' });
    expect(values.US.specialAreas.map((item) => item.value)).toEqual(['AK', 'DE', 'MT', 'NH', 'OR']);
    expect(values.HK.adminShortcuts.map((item) => item.value)).toContain('Central and Western');
    expect(values.HK.popularCities.map((item) => item.value)).toContain('Central');
  });

  it('accepts a strict override and leaves other defaults intact', () => {
    const original = countryShortcutDefaults().CN;
    const custom = strictCountryShortcutConfig('CN', {
      ...original,
      popularCities: [{ label: { en: 'Beijing', 'zh-CN': '北京' }, value: '北京市', type: 'city' }]
    });
    const effective = effectiveCountryShortcuts({ CN: custom });
    expect(effective.CN.popularCities).toHaveLength(1);
    expect(effective.US.popularCities).toHaveLength(12);
  });

  it('rejects duplicate, malformed, or semantically incorrect items', () => {
    const original = countryShortcutDefaults().US;
    expect(() => strictCountryShortcutConfig('US', {
      ...original,
      adminShortcuts: [{ label: { en: 'California', 'zh-CN': '加州' }, value: 'CA', type: 'city' }]
    })).toThrow('INVALID_COUNTRY_SHORTCUTS');
    expect(() => strictCountryShortcutConfig('US', {
      ...original,
      specialAreas: [original.specialAreas[0], original.specialAreas[0]]
    })).toThrow('DUPLICATE_COUNTRY_SHORTCUT');
    expect(() => strictCountryShortcutConfig('US', {
      ...original,
      specialAreaTitle: { en: '<script>', 'zh-CN': '特殊地区' }
    })).toThrow('INVALID_COUNTRY_SHORTCUTS');
  });
});
