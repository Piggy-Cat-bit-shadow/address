import { countries, isCountryCode } from '../../src/domain/countries.ts';
import type {
  CountryCode, CountryShortcutConfig, LocalizedText, LocationShortcut
} from '../../src/domain/types.ts';

export type CountryShortcutOverrides = Partial<Record<CountryCode, CountryShortcutConfig>>;
export type CountryShortcutMap = Record<CountryCode, CountryShortcutConfig>;

const shortcutTypes = new Set<LocationShortcut['type']>(['region', 'city', 'postcode']);
const maxItemsPerSection = 100;

const defaults = Object.fromEntries(countries.map((country) => [country.code, {
  countryCode: country.code,
  popularCities: country.popularCities,
  adminShortcuts: country.adminShortcuts,
  specialAreaTitle: country.specialAreaTitle,
  specialAreas: country.specialAreas
}])) as CountryShortcutMap;

const strictString = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string') throw new Error('INVALID_COUNTRY_SHORTCUTS');
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[<>\u0000-\u001f]/u.test(normalized)) {
    throw new Error('INVALID_COUNTRY_SHORTCUTS');
  }
  return normalized;
};

const strictLabel = (value: unknown): LocalizedText => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_COUNTRY_SHORTCUTS');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'en' && key !== 'zh-CN')) throw new Error('INVALID_COUNTRY_SHORTCUTS');
  return { en: strictString(record.en, 100), 'zh-CN': strictString(record['zh-CN'], 100) };
};

const strictItems = (value: unknown, requiredType?: LocationShortcut['type']): LocationShortcut[] => {
  if (!Array.isArray(value) || value.length > maxItemsPerSection) throw new Error('INVALID_COUNTRY_SHORTCUTS');
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('INVALID_COUNTRY_SHORTCUTS');
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['label', 'value', 'type'].includes(key))) throw new Error('INVALID_COUNTRY_SHORTCUTS');
    if (!shortcutTypes.has(record.type as LocationShortcut['type'])) throw new Error('INVALID_COUNTRY_SHORTCUTS');
    if (requiredType && record.type !== requiredType) throw new Error('INVALID_COUNTRY_SHORTCUTS');
    const shortcut: LocationShortcut = {
      label: strictLabel(record.label),
      value: strictString(record.value, 160),
      type: record.type as LocationShortcut['type']
    };
    const key = `${shortcut.type}:${shortcut.value.toLocaleLowerCase()}`;
    if (seen.has(key)) throw new Error('DUPLICATE_COUNTRY_SHORTCUT');
    seen.add(key);
    return shortcut;
  });
};

export const strictCountryShortcutConfig = (countryCode: string, input: unknown): CountryShortcutConfig => {
  if (!isCountryCode(countryCode) || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('INVALID_COUNTRY_SHORTCUTS');
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['countryCode', 'popularCities', 'adminShortcuts', 'specialAreaTitle', 'specialAreas'].includes(key))) {
    throw new Error('INVALID_COUNTRY_SHORTCUTS');
  }
  if (record.countryCode !== undefined && record.countryCode !== countryCode) throw new Error('INVALID_COUNTRY_SHORTCUTS');
  return {
    countryCode,
    popularCities: strictItems(record.popularCities, 'city'),
    adminShortcuts: strictItems(record.adminShortcuts, 'region'),
    specialAreaTitle: strictLabel(record.specialAreaTitle),
    specialAreas: strictItems(record.specialAreas)
  };
};

export const countryShortcutDefaults = (): CountryShortcutMap => structuredClone(defaults);

export const countryShortcutOverrides = (input: unknown): CountryShortcutOverrides => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const values: CountryShortcutOverrides = {};
  for (const [countryCode, value] of Object.entries(input)) {
    if (!isCountryCode(countryCode)) continue;
    try { values[countryCode] = strictCountryShortcutConfig(countryCode, value); }
    catch { continue; }
  }
  return values;
};

export const effectiveCountryShortcuts = (input: unknown): CountryShortcutMap => ({
  ...countryShortcutDefaults(),
  ...countryShortcutOverrides(input)
});
