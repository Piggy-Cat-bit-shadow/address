import { describe, expect, it } from 'vitest';
import {
  addressLanguageStorageKey,
  profileLanguageStorageKey,
  readStoredDisplayLanguage,
  storeDisplayLanguage
} from '../src/components/App';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
};

describe('generator language preferences', () => {
  it('defaults missing and invalid preferences to English', () => {
    const storage = memoryStorage();
    expect(readStoredDisplayLanguage(addressLanguageStorageKey, storage)).toBe('en');
    storage.setItem(addressLanguageStorageKey, 'invalid');
    expect(readStoredDisplayLanguage(addressLanguageStorageKey, storage)).toBe('en');
  });

  it('persists address and profile languages independently', () => {
    const storage = memoryStorage();
    storeDisplayLanguage(addressLanguageStorageKey, 'zh-CN', storage);
    storeDisplayLanguage(profileLanguageStorageKey, 'ja', storage);
    expect(readStoredDisplayLanguage(addressLanguageStorageKey, storage)).toBe('zh-CN');
    expect(readStoredDisplayLanguage(profileLanguageStorageKey, storage)).toBe('ja');
  });

  it('accepts the original-language preference', () => {
    const storage = memoryStorage();
    storeDisplayLanguage(addressLanguageStorageKey, 'native', storage);
    expect(readStoredDisplayLanguage(addressLanguageStorageKey, storage)).toBe('native');
  });
});
