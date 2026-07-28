import { isValidPostcode } from './postcode-patterns.mjs';

const policies = {
  US: { admin1: true, locality: true, postcode: true },
  CA: { admin1: true, locality: true, postcode: true },
  MX: { admin1: true, locality: true, district: true, postcode: true },
  GB: { locality: true, postcode: true },
  DE: { locality: true, postcode: true },
  FR: { locality: true, postcode: true },
  IT: { admin1: true, locality: true, postcode: true },
  ES: { admin1: true, locality: true, postcode: true },
  NL: { locality: true, postcode: true },
  JP: { admin1: true, locality: true, district: true, postcode: true },
  CN: { admin1: true, locality: true, district: true, postcode: false },
  HK: { locality: true, postcode: false },
  TW: { admin1: true, locality: true, district: true, postcode: true },
  KR: { admin1: true, locality: true, district: true, postcode: true },
  SG: { postcode: true },
  MY: { admin1: true, locality: true, postcode: true },
  TH: { admin1: true, locality: true, district: true, postcode: true },
  PH: { admin1: true, locality: true, district: true, postcode: true },
  VN: { admin1: true, locality: true, district: true, postcode: true },
  TR: { admin1: true, locality: true, district: true, postcode: true },
  SA: { locality: true, district: true, postcode: true },
  IN: { admin1: true, locality: true, district: true, postcode: true },
  AU: { admin1: true, locality: true, postcode: true },
  BR: { admin1: true, locality: true, district: true, postcode: true },
  NG: { admin1: true, locality: true, district: true, postcode: true },
  ZA: { admin1: true, locality: true, district: true, postcode: true },
  RU: { admin1: true, locality: true, postcode: true }
};

const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const compact = (value) => clean(value).replace(/\s+/gu, '').toUpperCase();

export const normalizePostcode = (countryCode, value) => {
  const country = clean(countryCode).toUpperCase();
  const source = clean(value).toUpperCase();
  if (!source) return '';
  const packed = compact(source);
  if (country === 'CA' && /^[A-Z]\d[A-Z]\d[A-Z]\d$/u.test(packed)) return `${packed.slice(0, 3)} ${packed.slice(3)}`;
  if (country === 'GB' && /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/u.test(packed)) return `${packed.slice(0, -3)} ${packed.slice(-3)}`;
  if (country === 'NL' && /^\d{4}[A-Z]{2}$/u.test(packed)) return `${packed.slice(0, 4)} ${packed.slice(4)}`;
  if (country === 'JP' && /^\d{7}$/u.test(packed)) return `${packed.slice(0, 3)}-${packed.slice(3)}`;
  if (country === 'BR' && /^\d{8}$/u.test(packed)) return `${packed.slice(0, 5)}-${packed.slice(5)}`;
  if (country === 'IN' && /^\d{6}$/u.test(packed)) return packed;
  return source;
};

const localityValue = (components) => clean(components.locality || components.postalLocality);
const districtValue = (components) => clean(components.district || components.dependentLocality);

export const normalizeAddressFacts = (countryCode, input = {}) => {
  const components = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value]));
  components.postcode = normalizePostcode(countryCode, components.postcode);
  const buildingName = clean(components.buildingName);
  const unit = clean(components.unit);
  if (/^\d+[\p{L}\p{N}./-]*$/u.test(buildingName) && (!unit || unit === buildingName)) {
    components.unit = unit || buildingName;
    delete components.buildingName;
  } else if (/^(?:apt|apartment|unit|ste|suite|fl|floor|bldg|building|#|no\.?)$/iu.test(buildingName)) {
    delete components.buildingName;
  }
  return components;
};

export const validateAddressQuality = ({ countryCode, components } = {}) => {
  const country = clean(countryCode).toUpperCase();
  const policy = policies[country];
  const normalizedComponents = normalizeAddressFacts(country, components);
  const reasons = [];
  if (!policy) reasons.push('unsupported_country');
  if (!clean(normalizedComponents.houseNumber)) reasons.push('missing_house_number');
  if (!clean(normalizedComponents.street)) reasons.push('missing_street');
  if (policy?.admin1 && !clean(normalizedComponents.admin1 || normalizedComponents.admin1Code)) reasons.push('missing_admin1');
  if (policy?.locality && !localityValue(normalizedComponents)) reasons.push('missing_locality');
  if (policy?.district && !districtValue(normalizedComponents)) reasons.push('missing_district');
  const postcode = clean(normalizedComponents.postcode);
  if (policy?.postcode && !postcode) reasons.push('missing_postcode');
  else if (postcode && !isValidPostcode(country, postcode)) reasons.push('invalid_postcode');
  if (clean(normalizedComponents.buildingName) && /^\d+[\p{L}\p{N}./-]*$/u.test(clean(normalizedComponents.buildingName))) {
    reasons.push('numeric_building_name');
  }
  return { valid: reasons.length === 0, reasons, components: normalizedComponents };
};

export const addressQualitySqlClause = (prefix = '') => {
  const value = (field) => `trim(${prefix}${field}) <> ''`;
  const city = `(${value('locality')} OR (${value('postal_locality')} AND ${prefix}postal_locality <> ${prefix}street))`;
  const district = `(${value('district')})`;
  const region = `(${value('admin1')} OR ${value('admin1_code')})`;
  const groups = new Map();
  for (const [country, policy] of Object.entries(policies)) {
    const checks = [value('house_number'), value('street')];
    if (policy.admin1) checks.push(region);
    if (policy.locality) checks.push(city);
    if (policy.district) checks.push(district);
    if (policy.postcode) checks.push(value('postcode'));
    const expression = checks.join(' AND ');
    const countries = groups.get(expression) || [];
    countries.push(country);
    groups.set(expression, countries);
  }
  return `(${[...groups].map(([expression, countries]) => `(${prefix}country_code IN (${countries.map((country) => `'${country}'`).join(',')}) AND ${expression})`).join(' OR ')})`;
};

export const countryAddressPolicies = policies;
