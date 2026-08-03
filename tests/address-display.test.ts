import { describe, expect, it } from 'vitest';
import {
  addressDisplayComponents,
  addressDisplayCountryName,
  addressDisplayPresentation,
  componentLooksLocalized,
  composeTranslatedPresentation,
  matchesNativeLanguage,
  storedVariantLooksLocalized
} from '../src/domain/address-display';
import { generateBundle } from '../src/domain/generator';
import { eligibleAddresses } from './fixtures/catalog';

const now = new Date('2026-07-20T00:00:00.000Z');

describe('address display localization', () => {
  it('keeps trusted variants unchanged', () => {
    const bundle = generateBundle(eligibleAddresses('GB', false, now)[0], true, 'display-language', undefined, now);
    expect(addressDisplayPresentation(bundle, 'native', 'zh-CN')).toBe(bundle.addressFormats.native);
    expect(addressDisplayPresentation(bundle, 'en', 'zh-CN')).toBe(bundle.addressFormats.en);
    expect(addressDisplayComponents(bundle, 'zh-CN')).toBe(bundle.address.componentVariants['zh-CN']);
  });

  it('renders the full native variant when the display locale matches the address language', () => {
    const bundle = generateBundle(eligibleAddresses('DE', false, now)[0], true, 'display-language', undefined, now);
    expect(bundle.address.nativeLanguage).toBe('de');
    expect(addressDisplayPresentation(bundle, 'de', 'zh-CN')).toBe(bundle.addressFormats.native);
    expect(addressDisplayComponents(bundle, 'de')).toBe(bundle.address.componentVariants.native);
  });

  it('matches display locales against the address native language by language code', () => {
    expect(matchesNativeLanguage('de', 'de')).toBe(true);
    expect(matchesNativeLanguage('ja', 'ja')).toBe(true);
    expect(matchesNativeLanguage('es', 'es')).toBe(true);
    expect(matchesNativeLanguage('pt', 'pt-BR')).toBe(true);
    expect(matchesNativeLanguage('zh-TW', 'zh-TW')).toBe(true);
    expect(matchesNativeLanguage('zh-TW', 'zh-HK')).toBe(true);
    expect(matchesNativeLanguage('zh-TW', 'zh-CN')).toBe(false);
    expect(matchesNativeLanguage('ja', 'de')).toBe(false);
    expect(matchesNativeLanguage('native', 'de')).toBe(false);
  });

  it('localizes the destination country without translating address proper nouns', () => {
    const bundle = generateBundle(eligibleAddresses('GB', false, now)[0], true, 'display-language', undefined, now);
    const english = bundle.addressFormats.en;
    const japanese = addressDisplayPresentation(bundle, 'ja', 'zh-CN');
    expect(japanese.postalLines.slice(0, -1)).toEqual(english.postalLines.slice(0, -1));
    expect(japanese.postalLines.at(-1)).toBe('イギリス');
    expect(addressDisplayComponents(bundle, 'ja')).toBe(bundle.address.componentVariants.en);
    expect(addressDisplayCountryName('GB', 'ja', 'zh-CN')).toBe('イギリス');
  });

  it('composes translated components with the source country line order', () => {
    const bundle = generateBundle(eligibleAddresses('GB', false, now)[0], true, 'display-language', undefined, now);
    const components = { ...bundle.address.componentVariants.en, street: '訳ストリート', locality: '訳ロンドン' };
    const presentation = composeTranslatedPresentation(bundle.address.countryCode, components, 'ja', 'en');
    expect(presentation.postalLines.at(-1)).toBe('イギリス');
    expect(presentation.singleLine.endsWith('イギリス')).toBe(true);
    expect(presentation.postalLines.join('\n')).toContain(`${components.houseNumber} 訳ストリート`);
  });
});

describe('untranslated-variant detection', () => {
  it('rejects foreign scripts per target locale and accepts shared Han', () => {
    expect(componentLooksLocalized('さくら通り', 'zh-CN')).toBe(false);
    expect(componentLooksLocalized('永福四丁目', 'zh-CN')).toBe(true);
    expect(componentLooksLocalized('서울로', 'zh-CN')).toBe(false);
    expect(componentLooksLocalized('ถนนสาทร', 'zh-CN')).toBe(false);
    expect(componentLooksLocalized('шоссе Ленина', 'zh-CN')).toBe(false);
    expect(componentLooksLocalized('شارع الملك', 'zh-CN')).toBe(false);
    expect(componentLooksLocalized('Main Street 12', 'zh-CN')).toBe(true);
    expect(componentLooksLocalized('東京都', 'en')).toBe(false);
    expect(componentLooksLocalized('さくら', 'en')).toBe(false);
    expect(componentLooksLocalized('서울', 'en')).toBe(false);
    expect(componentLooksLocalized('Москва', 'en')).toBe(false);
    expect(componentLooksLocalized('Sakura Street 4-27-7', 'en')).toBe(true);
    expect(componentLooksLocalized('東京都', 'de')).toBe(false);
    expect(componentLooksLocalized('Königstraße', 'de')).toBe(true);
    expect(componentLooksLocalized('さくら通り', 'ja')).toBe(true);
    expect(componentLooksLocalized('사쿠라', 'ja')).toBe(false);
    expect(componentLooksLocalized('강남대로', 'ko')).toBe(true);
    expect(componentLooksLocalized('江南', 'ko')).toBe(true);
    expect(componentLooksLocalized('さくら', 'ko')).toBe(false);
    expect(componentLooksLocalized('復興門內大街', 'zh-TW')).toBe(true);
  });

  it('routes a stored variant with untranslated semantic components to the endpoint path', () => {
    const jp = eligibleAddresses('JP', false, now)[0];
    const stored = { ...jp.componentVariants['zh-CN'], buildingName: undefined };
    expect(storedVariantLooksLocalized(jp.componentVariants['zh-CN'], 'zh-CN')).toBe(false);
    expect(storedVariantLooksLocalized(stored, 'zh-CN')).toBe(true);
    expect(storedVariantLooksLocalized({ ...stored, street: 'さくら通り' }, 'zh-CN')).toBe(false);
    expect(storedVariantLooksLocalized({ ...stored, buildingName: 'メゾン桜' }, 'zh-CN')).toBe(false);
    expect(storedVariantLooksLocalized({ ...stored, street: '桜通り' }, 'en')).toBe(false);
  });

  it('never inspects digit identifiers', () => {
    const jp = eligibleAddresses('JP', false, now)[0];
    const stored = { ...jp.componentVariants['zh-CN'], buildingName: undefined };
    expect(storedVariantLooksLocalized({ ...stored, houseNumber: '４ーの２', unit: 'ハイツ201', postcode: '〒168' }, 'zh-CN')).toBe(true);
  });
});
