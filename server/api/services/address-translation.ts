import { Converter as createTraditionalizer } from 'opencc-js/cn2t';
import { Converter as createSimplifier } from 'opencc-js/t2cn';
import { pinyin } from 'pinyin-pro';
import type { Database } from '../../database/database.mjs';
import {
  componentLooksLocalized,
  composeTranslatedPresentation,
  matchesNativeLanguage,
  storedVariantLooksLocalized
} from '../../../src/domain/address-display.ts';
import type { AddressComponents, Locale, VerifiedAddress } from '../../../src/domain/types.ts';
import { translateGoogleBatch } from './google-translator.ts';
import { translateYoudaoBatch, type YoudaoCredentials } from './youdao-translator.ts';
import { parseYoudaoSecret } from '../../control/store';

export interface AddressTranslationBindings {
  LOCATION_DB?: Database;
  GOOGLE_TRANSLATION_ENABLED?: boolean | string;
  YOUDAO_APP_KEY?: string;
  YOUDAO_APP_SECRET?: string;
  // Optional control-store seam: returns the stored secret for a service
  // provider; the environment bindings above remain the fallback.
  SERVICE_CREDENTIALS?: (provider: 'youdao') => Promise<string | undefined>;
}

export type TranslatableLocale = Locale;

export type AddressTranslationResult =
  | { status: 'translated'; components: AddressComponents; lines: string[]; singleLine: string }
  | { status: 'fallback' }
  | { status: 'unavailable' };

const translatableLocales = new Set<string>(['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt']);

export const isTranslatableLocale = (value: unknown): value is TranslatableLocale =>
  typeof value === 'string' && translatableLocales.has(value);

const semanticFields = [
  'buildingName', 'street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'
] as const satisfies ReadonlyArray<keyof AddressComponents>;

const toTraditional = createTraditionalizer({ from: 'cn', to: 'tw' });
// Japanese Shinjitai and shared traditional Han forms → Simplified Chinese,
// a zero-network first step for zh-CN targets whose components are Han-only.
const toSimplified = createSimplifier({ from: 'jp', to: 'cn' });

const digitSequences = (value: string): string => (value.match(/\p{Decimal_Number}+/gu) || []).join(',');
const CJK_NUMERAL_PATTERN = /[〇一二三四五六七八九十百千]/u;
// Translating CJK numerals legitimately introduces Arabic digits (二丁目 → 2-chome),
// so a digit-free source with CJK numerals may gain digits; otherwise sequences must match.
const preservesDigits = (source: string, translated: string): boolean => {
  const sourceDigits = digitSequences(source);
  if (sourceDigits === digitSequences(translated)) return true;
  return !sourceDigits && CJK_NUMERAL_PATTERN.test(source);
};

// Digit identifiers are copied verbatim from the source variant and never sent
// to the translation provider.
const preserveIdentifiers = (source: AddressComponents, translated: AddressComponents): AddressComponents => ({
  ...translated,
  houseNumber: source.houseNumber,
  ...(source.unit !== undefined ? { unit: source.unit } : {}),
  postcode: source.postcode,
  ...(source.admin1Code !== undefined ? { admin1Code: source.admin1Code } : {})
});

const identifiersPreserved = (source: AddressComponents, translated: AddressComponents): boolean =>
  (['houseNumber', 'unit', 'postcode'] as const).every((field) =>
    (source[field] || '') === (translated[field] || ''));

// Revision bump invalidates entries cached before localization validation
// existed, so previously stored incomplete translations never stick.
const CACHE_REVISION = 'xlate-v2';

const cacheKey = (address: VerifiedAddress): string =>
  [CACHE_REVISION, address.id, address.sourceVersion, address.sourceUpdatedAt].join(':');

interface CachedTranslation { provider: string; components: AddressComponents }

const readCached = async (
  db: Database | undefined,
  address: VerifiedAddress,
  locale: TranslatableLocale,
  source: AddressComponents
): Promise<AddressComponents | undefined> => {
  if (!db) return undefined;
  try {
    const row = await db.prepare('SELECT value FROM translation_cache WHERE cache_key = ? AND target_language = ?')
      .bind(cacheKey(address), locale).first<{ value: string }>();
    if (!row?.value) return undefined;
    const parsed = JSON.parse(row.value) as Partial<CachedTranslation> | undefined;
    const components = parsed?.components;
    if (!components || typeof components !== 'object' || typeof components.street !== 'string') return undefined;
    return identifiersPreserved(source, components) && storedVariantLooksLocalized(components, locale)
      ? components
      : undefined;
  } catch {
    return undefined;
  }
};

const writeCached = async (
  db: Database | undefined,
  address: VerifiedAddress,
  locale: TranslatableLocale,
  provider: string,
  components: AddressComponents
): Promise<void> => {
  if (!db) return;
  try {
    await db.prepare(`INSERT INTO translation_cache(cache_key, target_language, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key, target_language) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(cacheKey(address), locale, JSON.stringify({ provider, components } satisfies CachedTranslation), new Date().toISOString()).run();
  } catch {}
};

const mapComponents = (source: AddressComponents, transform: (value: string) => string): AddressComponents =>
  Object.fromEntries(
    Object.entries(source).map(([field, value]) => [field, typeof value === 'string' ? transform(value) : value])
  ) as unknown as AddressComponents;

const titleCase = (value: string): string => value
  .split(/\s+/u).filter(Boolean)
  .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
  .join(' ');

// Last-resort romanization for Chinese-source components when every provider
// failed an English target: title-cased pinyin beats hanzi in an "English"
// address. Rejects itself unless the result is fully Latin with digits intact.
const romanizedComponents = (source: AddressComponents): AddressComponents | undefined => {
  const result = { ...source };
  for (const field of semanticFields) {
    const value = source[field];
    if (typeof value !== 'string' || !value.trim() || componentLooksLocalized(value, 'en')) continue;
    const candidate = titleCase(pinyin(value, { toneType: 'none', nonZh: 'consecutive' }).trim());
    if (!candidate || !componentLooksLocalized(candidate, 'en') || !preservesDigits(value, candidate)) return undefined;
    (result as Record<string, unknown>)[field] = candidate;
  }
  return preserveIdentifiers(source, result);
};

const youdaoLanguage = (locale: TranslatableLocale): string =>
  locale === 'zh-CN' ? 'zh-CHS' : locale === 'zh-TW' ? 'zh-CHT' : locale.split('-')[0];

interface TranslationProvider {
  name: string;
  translate: (values: string[]) => Promise<string[] | undefined>;
}

const youdaoCredentials = async (bindings: AddressTranslationBindings): Promise<YoudaoCredentials | undefined> => {
  if (bindings.SERVICE_CREDENTIALS) {
    const stored = parseYoudaoSecret(await bindings.SERVICE_CREDENTIALS('youdao').catch(() => undefined));
    if (stored) return stored;
  }
  return bindings.YOUDAO_APP_KEY && bindings.YOUDAO_APP_SECRET
    ? { appKey: bindings.YOUDAO_APP_KEY, appSecret: bindings.YOUDAO_APP_SECRET }
    : undefined;
};

// Ordered provider chain; each provider call carries its own request timeout
// via the shared fetchWithTimeout inside the batch translators.
const providerChain = async (
  locale: TranslatableLocale,
  bindings: AddressTranslationBindings,
  fetcher: typeof fetch
): Promise<TranslationProvider[]> => {
  const chain: TranslationProvider[] = [];
  if (bindings.GOOGLE_TRANSLATION_ENABLED !== false && bindings.GOOGLE_TRANSLATION_ENABLED !== 'false') {
    chain.push({ name: 'google', translate: (values) => translateGoogleBatch(values, 'auto', locale, fetcher) });
  }
  const credentials = await youdaoCredentials(bindings);
  if (credentials) {
    chain.push({ name: 'youdao', translate: (values) => translateYoudaoBatch(values, 'auto', youdaoLanguage(locale), credentials, fetcher) });
  }
  return chain;
};

// Any missing, digit-mutating, or still-foreign-script candidate rejects the
// whole batch so the caller can try the next provider or fall back to the
// complete original, never a mixed rendering.
const translatedCandidate = (
  source: AddressComponents,
  selected: ReadonlyArray<{ field: typeof semanticFields[number]; value: string }>,
  values: string[],
  translations: string[] | undefined,
  locale: TranslatableLocale
): AddressComponents | undefined => {
  if (!translations) return undefined;
  const translated = new Map(values.map((value, index) => [value, translations[index]]));
  const result = { ...source };
  for (const { field, value } of selected) {
    const candidate = translated.get(value)?.trim();
    if (!candidate || !preservesDigits(value, candidate) || !componentLooksLocalized(candidate, locale)) return undefined;
    (result as Record<string, unknown>)[field] = candidate;
  }
  return preserveIdentifiers(source, result);
};

type ResolvedComponents =
  | { status: 'ok'; components: AddressComponents }
  | { status: 'fallback' | 'unavailable' };

const resolveLocalizedComponents = async (
  address: VerifiedAddress,
  locale: Exclude<TranslatableLocale, 'zh-TW'>,
  bindings: AddressTranslationBindings,
  fetcher: typeof fetch
): Promise<ResolvedComponents> => {
  const source = locale === 'zh-CN' ? address.componentVariants['zh-CN'] : address.componentVariants.en;
  if (locale === 'en' && storedVariantLooksLocalized(source, locale)) {
    return { status: 'ok', components: source };
  }
  if (locale === 'zh-CN') {
    // Zero-network first step: normalize Japanese Shinjitai and shared
    // traditional Han forms to Simplified before judging the stored variant.
    const simplified = preserveIdentifiers(source, mapComponents(source, toSimplified));
    if (storedVariantLooksLocalized(simplified, locale)) return { status: 'ok', components: simplified };
  }
  const cached = await readCached(bindings.LOCATION_DB, address, locale, source);
  if (cached) return { status: 'ok', components: cached };
  const selected = semanticFields
    .map((field) => ({ field, value: source[field] }))
    .filter((item): item is { field: typeof semanticFields[number]; value: string } =>
      typeof item.value === 'string' && Boolean(item.value.trim()));
  const values = [...new Set(selected.map(({ value }) => value))];
  if (!values.length) return { status: 'ok', components: source };
  const chain = await providerChain(locale, bindings, fetcher);
  for (const provider of chain) {
    let translations: string[] | undefined;
    try {
      translations = await provider.translate(values);
    } catch {
      translations = undefined;
    }
    const candidate = translatedCandidate(source, selected, values, translations, locale);
    if (candidate) {
      await writeCached(bindings.LOCATION_DB, address, locale, provider.name, candidate);
      return { status: 'ok', components: candidate };
    }
  }
  if (locale === 'en' && address.countryCode === 'CN') {
    const romanized = romanizedComponents(source);
    if (romanized) {
      await writeCached(bindings.LOCATION_DB, address, locale, 'pinyin', romanized);
      return { status: 'ok', components: romanized };
    }
  }
  return { status: chain.length ? 'fallback' : 'unavailable' };
};

// Resolves a complete localized component set for any display locale:
// native short-circuit → trusted stored variant → zero-network script
// conversion → provider chain → honest full fallback.
export const translateAddressComponents = async (
  address: VerifiedAddress,
  locale: TranslatableLocale,
  bindings: AddressTranslationBindings,
  fetcher: typeof fetch = fetch
): Promise<AddressTranslationResult> => {
  if (matchesNativeLanguage(locale, address.nativeLanguage)) {
    const components = address.componentVariants.native;
    return { status: 'translated', components, ...presentationFor(address, components, locale) };
  }
  if (locale === 'zh-TW') {
    const resolved = await resolveLocalizedComponents(address, 'zh-CN', bindings, fetcher);
    if (resolved.status !== 'ok') return { status: resolved.status };
    const components = preserveIdentifiers(resolved.components, mapComponents(resolved.components, toTraditional));
    return { status: 'translated', components, ...presentationFor(address, components, locale) };
  }
  const resolved = await resolveLocalizedComponents(address, locale, bindings, fetcher);
  if (resolved.status !== 'ok') return { status: resolved.status };
  return { status: 'translated', components: resolved.components, ...presentationFor(address, resolved.components, locale) };
};

const presentationFor = (
  address: VerifiedAddress,
  components: AddressComponents,
  locale: TranslatableLocale
): { lines: string[]; singleLine: string } => {
  const presentation = composeTranslatedPresentation(address.countryCode, components, locale, 'en');
  return { lines: presentation.postalLines, singleLine: presentation.singleLine };
};
