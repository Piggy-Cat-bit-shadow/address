import { describe, expect, it } from 'vitest';
import { generateBundle } from '../src/domain/generator';
import {
  localizedProfileValue, profileLanguageNames, resolvedProfileLocale
} from '../src/domain/profile-localization';
import { supportedLocales } from '../src/domain/types';
import { eligibleAddresses } from './fixtures/catalog';

const now = new Date('2026-07-20T00:00:00.000Z');

describe('multilingual profile presentations', () => {
  it('generates every supported presentation deterministically', () => {
    const address = eligibleAddresses('DE', false, now)[0];
    const first = generateBundle(address, true, 'profile-languages', undefined, now);
    const second = generateBundle(address, true, 'profile-languages', undefined, now);

    expect(Object.keys(first.profilePresentations || {})).toEqual([...supportedLocales]);
    expect(first.profilePresentations).toEqual(second.profilePresentations);
    expect(first.profilePresentations?.en.fullName).not.toBe(first.profilePresentations?.['zh-CN'].fullName);
    expect(first.profilePresentations?.['zh-CN'].fullName).toMatch(/[\p{Script=Han}]/u);
    expect(first.profilePresentations?.ja.fullName).toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
    expect(first.profilePresentations?.ko.fullName).toMatch(/[\p{Script=Hangul}]/u);
  });

  it('keeps canonical identifiers and numeric data outside localized presentations', () => {
    const bundle = generateBundle(eligibleAddresses('US', false, now)[0], true, 'stable-fields', undefined, now);
    const before = {
      email: bundle.profile.email,
      phone: bundle.profile.phone,
      dateOfBirth: bundle.profile.dateOfBirth,
      username: bundle.extensions.internet.username,
      password: bundle.extensions.internet.testPassword,
      url: bundle.extensions.internet.url,
      uuid: bundle.extensions.internet.uuid,
      salary: 'salary' in bundle.extensions.employment ? bundle.extensions.employment.salary : undefined,
      income: bundle.extensions.finance.incomeRange,
      card: bundle.card
    };

    for (const presentation of Object.values(bundle.profilePresentations || {})) {
      expect(presentation.fullName).toBeTruthy();
      expect(presentation.accountDisplayName).toContain(presentation.fullName);
    }
    expect({
      email: bundle.profile.email,
      phone: bundle.profile.phone,
      dateOfBirth: bundle.profile.dateOfBirth,
      username: bundle.extensions.internet.username,
      password: bundle.extensions.internet.testPassword,
      url: bundle.extensions.internet.url,
      uuid: bundle.extensions.internet.uuid,
      salary: 'salary' in bundle.extensions.employment ? bundle.extensions.employment.salary : undefined,
      income: bundle.extensions.finance.incomeRange,
      card: bundle.card
    }).toEqual(before);
  });

  it('uses autonyms and resolves native profile languages without changing the country', () => {
    expect(profileLanguageNames).toEqual({
      en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어',
      de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português'
    });
    expect(resolvedProfileLocale('native', 'JP')).toBe('ja');
    expect(resolvedProfileLocale('native', 'HK')).toBe('zh-TW');
    expect(resolvedProfileLocale('native', 'BR')).toBe('pt');
    expect(resolvedProfileLocale('native', 'IT')).toBeUndefined();
  });

  it('localizes fixed work and profile values for the selected presentation language', () => {
    expect(localizedProfileValue('Software Engineer', 'ja', 'US')).toBe('ソフトウェアエンジニア');
    expect(localizedProfileValue('Finance', 'de', 'US')).toBe('Finanzen');
    expect(localizedProfileValue('Independent Data Scientist', 'fr', 'US')).toBe('Data scientist indépendant');
    expect(localizedProfileValue('master', 'ko', 'US')).toBe('석사');
    expect(localizedProfileValue('Savings Account', 'zh-TW', 'US')).toBe('儲蓄帳戶');
  });
});
