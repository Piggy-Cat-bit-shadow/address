import regionData from './regions.json';
import type { CountryCode, Locale, LocationOption } from './types';

interface RegionRecord {
  countryCode: CountryCode;
  name: string;
  native: string;
  zh: string;
  code: string;
}

const records = regionData as RegionRecord[];
const commonAbbreviations = new Set<CountryCode>(['US', 'CA', 'AU', 'BR', 'IN', 'MX', 'NG']);
const usStateCodes = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));

const normalize = (value: string): string => value.normalize('NFKD').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

const distinctLabels = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    const key = normalize(value || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const locationOptionLabel = (option: LocationOption, locale: Locale): string => {
  const english = option.en || option.value || option.label;
  if (locale === 'en') return english;
  const localized = locale === 'zh-CN'
    ? option.zhCN
    : locale === 'zh-TW'
      ? option.native || option.zhCN
      : option.native || option.zhCN;
  return distinctLabels([english, localized]).join(' · ') || option.label;
};

export const regionsForCountry = (countryCode: CountryCode, query = ''): LocationOption[] => {
  const needle = normalize(query);
  return records
    .filter((region) => region.countryCode === countryCode && (countryCode !== 'US' || usStateCodes.has(region.code)))
    .map((region) => {
      const value = countryCode === 'CN' ? region.native : region.name;
      const abbreviation = commonAbbreviations.has(countryCode) && region.code ? `（${region.code}）` : '';
      const label = countryCode === 'CN' ? region.zh : `${region.name}${abbreviation}${abbreviation ? '' : ' '}${region.zh}`;
      return { value, label, native: region.native, en: region.name, zhCN: region.zh, regionCode: region.code };
    })
    .filter((option) => !needle || normalize(`${option.value} ${option.label}`).includes(needle))
    .sort((left, right) => left.label.localeCompare(right.label, countryCode === 'CN' ? 'zh-CN' : 'en'));
};

export const locationOptions = (values: string[]): LocationOption[] => [...new Set(values.filter(Boolean))]
  .sort((left, right) => left.localeCompare(right))
  .map((value) => ({ value, label: value }));
