import { supportedLocales, type Locale } from './types';

export { supportedLocales };

export interface LocaleDefinition {
  code: Locale;
  label: string;
  htmlLang: string;
  hreflang: string;
}

export const localeDefinitions: readonly LocaleDefinition[] = [
  { code: 'en', label: 'English', htmlLang: 'en', hreflang: 'en' },
  { code: 'zh-CN', label: '简体中文', htmlLang: 'zh-CN', hreflang: 'zh-Hans' },
  { code: 'zh-TW', label: '繁體中文', htmlLang: 'zh-TW', hreflang: 'zh-Hant' },
  { code: 'ja', label: '日本語', htmlLang: 'ja', hreflang: 'ja' },
  { code: 'ko', label: '한국어', htmlLang: 'ko', hreflang: 'ko' },
  { code: 'de', label: 'Deutsch', htmlLang: 'de', hreflang: 'de' },
  { code: 'fr', label: 'Français', htmlLang: 'fr', hreflang: 'fr' },
  { code: 'es', label: 'Español', htmlLang: 'es', hreflang: 'es' },
  { code: 'pt', label: 'Português', htmlLang: 'pt', hreflang: 'pt' }
] as const;

const localeSet = new Set<string>(supportedLocales);

export const isLocale = (value: string | undefined | null): value is Locale => Boolean(value && localeSet.has(value));

export const matchLocale = (values: readonly string[], fallback: Locale = 'en'): Locale => {
  for (const source of values.flatMap((value) => value.split(','))) {
    const tag = source.trim().split(';', 1)[0].replace(/_/gu, '-');
    if (!tag) continue;
    const exact = supportedLocales.find((locale) => locale.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh-hant') || lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-mo')) return 'zh-TW';
    if (lower.startsWith('zh')) return 'zh-CN';
    const base = supportedLocales.find((locale) => locale.toLowerCase() === lower.split('-', 1)[0]);
    if (base) return base;
  }
  return fallback;
};

export const localeFromPath = (pathname: string): Locale | undefined => {
  const first = pathname.split('/').filter(Boolean)[0];
  return isLocale(first) ? first : undefined;
};

export const pathForLocale = (pathname: string, locale: Locale): string => {
  const segments = pathname.split('/').filter(Boolean);
  if (isLocale(segments[0])) segments.shift();
  const suffix = segments.length ? `${segments.join('/')}/` : '';
  return `/${locale}/${suffix}`;
};

export const uiTextLocale = (locale: Locale): 'en' | 'zh-CN' => locale === 'zh-CN' || locale === 'zh-TW' ? 'zh-CN' : 'en';

export const localizedCountryName = (countryCode: string, locale: Locale, fallback: string): string => {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(countryCode) || fallback;
  } catch {
    return fallback;
  }
};

export const localeStaticPaths = () => supportedLocales.map((locale) => ({ params: { locale } }));
