import { countryByCode } from './countries';
import { formatAddressPresentation } from './address-format';
import { localizedCountryName } from './locales';
import type {
  AddressComponents,
  AddressLanguage,
  AddressPresentation,
  CountryCode,
  GeneratedBundle,
  Locale,
  VerifiedAddress
} from './types';

export type AddressDisplayLanguage = 'native' | Locale;

const primaryLanguage = (tag: string): string => tag.split('-')[0].toLowerCase();
const chineseScript = (tag: string): 'Hans' | 'Hant' =>
  ['zh-TW', 'zh-HK', 'zh-MO'].includes(tag) || tag.includes('Hant') ? 'Hant' : 'Hans';

// A display locale in the address's own language (de → German address,
// pt → Brazilian address, zh-TW → Taiwan/Hong Kong address) renders the stored
// native variant directly — no translation is needed for a same-language target.
export const matchesNativeLanguage = (language: string, nativeLanguage: string): boolean =>
  primaryLanguage(language) === primaryLanguage(nativeLanguage)
  && (primaryLanguage(language) !== 'zh' || chineseScript(language) === chineseScript(nativeLanguage));

const trustedLanguage = (language: AddressDisplayLanguage, nativeLanguage: string): AddressLanguage | undefined => {
  if (language === 'native' || language === 'en' || language === 'zh-CN') return language;
  return matchesNativeLanguage(language, nativeLanguage) ? 'native' : undefined;
};

export const addressDisplayComponents = (
  bundle: GeneratedBundle,
  language: AddressDisplayLanguage
): AddressComponents => bundle.address.componentVariants[trustedLanguage(language, bundle.address.nativeLanguage) || 'en']
  || bundle.address.componentVariants.native;

export const addressDisplayCountryName = (
  countryCode: CountryCode,
  language: AddressDisplayLanguage,
  fallbackLocale: Locale
): string => {
  const country = countryByCode.get(countryCode);
  if (!country) return countryCode;
  if (language === 'native') return country.nativeName;
  if (language === 'en') return country.name.en;
  if (language === 'zh-CN') return country.name['zh-CN'];
  return localizedCountryName(countryCode, language, localizedCountryName(countryCode, fallbackLocale, country.name.en));
};

export const addressDisplayPresentation = (
  bundle: GeneratedBundle,
  language: AddressDisplayLanguage,
  fallbackLocale: Locale
): AddressPresentation => {
  const trusted = trustedLanguage(language, bundle.address.nativeLanguage);
  if (trusted) return bundle.addressFormats[trusted];

  const source = bundle.addressFormats.en || bundle.addressFormats.native;
  const sourceCountry = source.postalLines.at(-1) || '';
  const countryName = addressDisplayCountryName(bundle.address.countryCode, language, fallbackLocale)
    .toLocaleUpperCase(language);
  const postalLines = source.postalLines.length
    ? [...source.postalLines.slice(0, -1), countryName]
    : [countryName];
  const singleLine = sourceCountry && source.singleLine.endsWith(sourceCountry)
    ? `${source.singleLine.slice(0, -sourceCountry.length)}${countryName}`
    : `${source.singleLine}, ${countryName}`;

  return { ...source, postalLines, singleLine };
};

const scriptPatterns = {
  han: /[⺀-⻿㐀-䶿一-鿿豈-﫿]/u,
  kana: /[぀-ヿㇰ-ㇿｦ-ﾝ]/u,
  hangul: /[ᄀ-ᇿ㄰-㆏가-힯]/u,
  thai: /[฀-๿]/u,
  arabic: /[؀-ۿݐ-ݿ]/u,
  cyrillic: /[Ѐ-ӿ]/u
} as const;

// Scripts that cannot appear in a component correctly localized to the target
// locale. Han is shared between Chinese and Japanese (kanji≈hanzi), Latin
// identifiers and digits are acceptable everywhere.
const foreignScripts: Record<string, ReadonlyArray<RegExp>> = {
  zh: [scriptPatterns.kana, scriptPatterns.hangul, scriptPatterns.thai, scriptPatterns.arabic, scriptPatterns.cyrillic],
  ja: [scriptPatterns.hangul, scriptPatterns.thai, scriptPatterns.arabic, scriptPatterns.cyrillic],
  ko: [scriptPatterns.kana, scriptPatterns.thai, scriptPatterns.arabic, scriptPatterns.cyrillic],
  latin: [scriptPatterns.han, scriptPatterns.kana, scriptPatterns.hangul, scriptPatterns.thai, scriptPatterns.arabic, scriptPatterns.cyrillic]
};

export const componentLooksLocalized = (text: string, targetLocale: Locale): boolean => {
  const family = primaryLanguage(targetLocale);
  const rejected = foreignScripts[family] || foreignScripts.latin;
  return !rejected.some((pattern) => pattern.test(text));
};

const semanticDisplayFields = [
  'buildingName', 'street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'
] as const satisfies ReadonlyArray<keyof AddressComponents>;

// A stored variant is trusted for a display locale only when every semantic
// component already reads in the target script; digit identifiers
// (houseNumber, unit, postcode) are never inspected.
export const storedVariantLooksLocalized = (components: AddressComponents, targetLocale: Locale): boolean =>
  semanticDisplayFields.every((field) => {
    const value = components[field];
    return typeof value !== 'string' || !value.trim() || componentLooksLocalized(value, targetLocale);
  });

const latinScriptLocales = new Set<Locale>(['en', 'de', 'fr', 'es', 'pt']);

// Formats fully translated components with the SOURCE country's postal line
// order, then localizes the destination-country line to the target locale.
export const composeTranslatedPresentation = (
  countryCode: CountryCode,
  components: AddressComponents,
  language: Locale,
  fallbackLocale: Locale
): AddressPresentation => {
  const formatLanguage: AddressLanguage = latinScriptLocales.has(language) ? 'en' : 'native';
  const draft = {
    countryCode,
    componentVariants: { native: components, en: components, 'zh-CN': components }
  } as unknown as VerifiedAddress;
  const source = formatAddressPresentation(draft, formatLanguage, '');
  const country = countryByCode.get(countryCode);
  const countryName = addressDisplayCountryName(countryCode, language, fallbackLocale).toLocaleUpperCase(language);
  const comparable = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en').trim();
  const sourceCountry = source.postalLines.at(-1) || '';
  const hasCountryLine = Boolean(country) && [country!.nativeName, country!.name.en, country!.name['zh-CN']]
    .some((name) => comparable(name) === comparable(sourceCountry));
  const postalLines = hasCountryLine
    ? [...source.postalLines.slice(0, -1), countryName]
    : [...source.postalLines, countryName];
  const singleLine = hasCountryLine && source.singleLine.endsWith(sourceCountry)
    ? `${source.singleLine.slice(0, -sourceCountry.length)}${countryName}`
    : `${source.singleLine}, ${countryName}`;
  return { language: formatLanguage, postalLines, singleLine };
};
