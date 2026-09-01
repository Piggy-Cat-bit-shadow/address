import { describe, expect, it } from 'vitest';
import { englishMessages, messages } from '../src/domain/i18n';
import {
  isLocale, localeDefinitions, localeFromPath, matchLocale, pathForLocale, supportedLocales
} from '../src/domain/locales';

describe('localized URL routing', () => {
  it('keeps the supported locale registry complete and uses autonyms', () => {
    expect(supportedLocales).toEqual(['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt']);
    expect(localeDefinitions.map(({ label }) => label)).toEqual([
      'English', '简体中文', '繁體中文', '日本語', '한국어', 'Deutsch', 'Français', 'Español', 'Português'
    ]);
    expect(localeDefinitions.every(({ code }) => isLocale(code))).toBe(true);
  });

  it('matches exact, regional and Chinese script browser preferences', () => {
    expect(matchLocale(['fr-CA', 'en-US'])).toBe('fr');
    expect(matchLocale(['de-CH,de;q=0.9,en;q=0.8'])).toBe('de');
    expect(matchLocale(['zh-Hant-HK'])).toBe('zh-TW');
    expect(matchLocale(['zh-SG'])).toBe('zh-CN');
    expect(matchLocale(['unknown'])).toBe('en');
  });

  it('replaces only the locale segment and preserves the current page', () => {
    expect(localeFromPath('/ja/admin/')).toBe('ja');
    expect(localeFromPath('/admin/')).toBeUndefined();
    expect(pathForLocale('/zh-CN/', 'de')).toBe('/de/');
    expect(pathForLocale('/en/api/', 'fr')).toBe('/fr/api/');
    expect(pathForLocale('/admin/', 'ko')).toBe('/ko/admin/');
  });

  it('provides every frontend message key in every locale', () => {
    const keys = Object.keys(englishMessages).sort();
    for (const locale of supportedLocales) {
      expect(Object.keys(messages[locale]).sort(), locale).toEqual(keys);
      expect(Object.values(messages[locale]).every(Boolean), locale).toBe(true);
    }
  });
});
