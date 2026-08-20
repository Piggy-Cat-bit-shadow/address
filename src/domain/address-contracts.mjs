const required = {
  US: ['admin1', 'locality', 'postcode'], CA: ['admin1', 'locality', 'postcode'], MX: ['admin1', 'locality', 'district', 'postcode'],
  GB: ['locality', 'postcode'], DE: ['locality', 'postcode'], FR: ['locality', 'postcode'], IT: ['admin1', 'locality', 'postcode'], ES: ['admin1', 'locality', 'postcode'], NL: ['locality', 'postcode'], RU: ['admin1', 'locality', 'postcode'],
  JP: ['admin1', 'locality', 'district', 'postcode'], CN: ['admin1', 'locality', 'district'], HK: ['admin1', 'locality'], TW: ['admin1', 'locality', 'postcode'], KR: ['admin1', 'locality', 'district', 'postcode'], SG: ['postcode'], MY: ['admin1', 'locality', 'postcode'], TH: ['admin1', 'locality', 'district', 'postcode'], PH: ['admin1', 'locality', 'district', 'postcode'], VN: ['admin1', 'locality', 'postcode'], TR: ['admin1', 'locality', 'district', 'postcode'], SA: ['locality', 'district', 'postcode'], IN: ['admin1', 'locality', 'district', 'postcode'], AU: ['admin1', 'locality', 'postcode'], BR: ['admin1', 'locality', 'postcode'], NG: ['admin1', 'locality', 'district', 'postcode'], ZA: ['admin1', 'locality', 'district', 'postcode']
};
const adminCodes = new Set(['US', 'CA', 'AU', 'BR', 'MX', 'IT']);
const nativeScripts = { CN: /\p{Script=Han}/u, HK: /\p{Script=Han}/u, TW: /\p{Script=Han}/u, JP: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u, KR: /\p{Script=Hangul}/u, TH: /\p{Script=Thai}/u, SA: /\p{Script=Arabic}/u, RU: /\p{Script=Cyrillic}/u };
const traditionalChineseCountries = new Set(['HK', 'TW']);
const nonLatinCoreCountries = new Set(Object.keys(nativeScripts));
const nativeCoreFields = ['street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'];
const nativeLetter = /\p{L}/u;
const hasNonIdentifierLatin = (value) => /\p{Script=Latin}/u.test(String(value)
  .replace(/[A-Za-z]+\d[A-Za-z\d/-]*/gu, '')
  .replace(/\d+[A-Za-z][A-Za-z\d/-]*/gu, '')
  .replace(/[A-Za-z]+(?=[区座栋棟幢单元室号號楼])/gu, ''));

export const addressContracts = Object.fromEntries(Object.keys(required).map((code) => [code, { code, required: required[code], adminCode: adminCodes.has(code) }]));
export const requiresAdminCode = (countryCode) => Boolean(addressContracts[countryCode]?.adminCode);

export function validateNativeScript(countryCode, value, { strict = false } = {}) {
  const text = String(value ?? '').trim();
  const pattern = nativeScripts[countryCode];
  if (!pattern || !text) return Boolean(text);
  // Legacy rows may expose a Latin transliteration in the generic components;
  // strict enforcement is applied to the native localization at import time.
  return !strict || pattern.test(text);
}

export function validateAddressContract(countryCode, components = {}, { strict = false, requireAdminCode = true } = {}) {
  const contract = addressContracts[countryCode];
  if (!contract) return { valid: false, reasons: ['unsupported_country'] };
  const reasons = [];
  for (const field of contract.required) if (!String(components[field] ?? '').trim()) reasons.push(`missing_${field}`);
  if (strict) {
    const nativeValues = nativeCoreFields.map((field) => String(components[field] ?? '').trim()).filter(Boolean);
    const scriptedValues = nativeValues.filter((value) => nativeLetter.test(value));
    if (nativeScripts[countryCode] && (!scriptedValues.length
      || scriptedValues.some((value) => !validateNativeScript(countryCode, value, { strict: true })))) {
      reasons.push('invalid_native_script');
    }
    if (nonLatinCoreCountries.has(countryCode) && scriptedValues.some(hasNonIdentifierLatin)) {
      reasons.push('native_mixed_latin');
    }
    const nativeText = [...nativeValues, traditionalChineseCountries.has(countryCode) ? components.buildingName : '']
      .filter(Boolean).join(' ');
    if (traditionalChineseCountries.has(countryCode)
      && /[A-Za-z]/u.test(nativeText)) reasons.push('native_mixed_latin');
    if (requireAdminCode && contract.adminCode && !String(components.admin1Code ?? '').trim()) reasons.push('missing_admin1_code');
  }
  return { valid: reasons.length === 0, reasons };
}
