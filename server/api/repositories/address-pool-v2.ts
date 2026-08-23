import { hashSeed } from '../../../src/domain/generator';
import { Converter as createSimplifier } from 'opencc-js/t2cn';
import { Converter as createTraditionalizer } from 'opencc-js/cn2t';
import type { Database } from '../../database/database.mjs';
import { matchesCustomBlacklist } from '../../lib/custom-blacklist.mjs';
import {
  addressQualitySqlClause,
  normalizeAddressFacts,
  validateAddressQuality
} from '../../../src/domain/address-quality.mjs';
import {
  normalizeAddressComponents,
  validateAdministrativeHierarchy
} from '../../../src/domain/administrative-integrity.mjs';
import { findNonResidentialMatch } from '../../../src/domain/non-residential.mjs';
import { requiresAdminCode, validateAddressContract } from '../../../src/domain/address-contracts.mjs';
import { storedVariantLooksLocalized } from '../../../src/domain/address-display';
import type { AddressComponents, AddressEvidence, CountryCode, PropertyType, VerifiedAddress } from '../../../src/domain/types';
import type { AddressFilters, CatalogTarget } from './address-repository';

interface AddressPoolV2Row {
  id: string;
  country_code: CountryCode;
  admin1: string;
  admin1_code: string;
  locality: string;
  postal_locality: string;
  district: string;
  postcode: string;
  street: string;
  house_number: string;
  building_name: string;
  latitude: number;
  longitude: number;
  native_language: string;
  component_variants_json: string;
  address_variants_json: string;
  property_type: string;
  generation: string;
  quality_score: number;
  first_seen_at: string;
  expires_at: string | null;
  source_id: string | null;
  source_name: string | null;
  source_url: string | null;
  source_license: string | null;
  license_url: string | null;
  attribution_text: string | null;
  attribution_url: string | null;
  source_record_id: string | null;
  record_url: string | null;
  observed_at: string | null;
  evidence_type: string | null;
  residential_evidence: number;
  dataset_id: string | null;
  dataset_version: string | null;
  source_updated_at: string | null;
  imported_at: string | null;
}

const propertyTypes = new Set<PropertyType>(['residential', 'apartment', 'commercial', 'mixed', 'unknown']);
const evidenceTypes = new Set<AddressEvidence['type']>(['address_existence', 'residential_use', 'coordinate', 'building_status']);
const residentialEvidenceSource = (row: AddressPoolV2Row): Pick<AddressEvidence, 'sourceId' | 'sourceName' | 'sourceUrl' | 'sourceFamily'> =>
  row.source_id === 'overture-addresses'
    ? {
        sourceId: 'overture-buildings',
        sourceName: 'Overture Maps buildings',
        sourceUrl: 'https://docs.overturemaps.org/guides/buildings',
        sourceFamily: 'overture-buildings'
      }
    : {
        sourceId: row.source_id || '',
        sourceName: row.source_name || '',
        sourceUrl: row.record_url || row.source_url || '',
        sourceFamily: row.source_id || ''
      };

const normalize = (value: string | undefined): string => (value || '')
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/\s+/gu, ' ')
  .trim();

const toSimplifiedHan = createSimplifier({ from: 'hk', to: 'cn' });
const toTraditionalHongKong = createTraditionalizer({ from: 'cn', to: 'hk' });
const toTraditionalTaiwan = createTraditionalizer({ from: 'cn', to: 'tw' });
const hanScript = /\p{Script=Han}/u;
const latinScript = /\p{Script=Latin}/u;
const nativeSemanticFields = new Set(['street', 'locality', 'postalLocality', 'district', 'dependentLocality', 'admin1', 'buildingName']);
const hasHanSemanticContent = (components: AddressComponents): boolean => [...nativeSemanticFields]
  .some((field) => hanScript.test(String(components[field as keyof AddressComponents] || '')));
export const chineseVariantHasHanClause = (prefix = ''): string => `(${[...nativeSemanticFields]
  .map((field) => `(${prefix}component_variants_json::jsonb -> 'zh-CN' ->> '${field}') ~ '[一-龥]'`)
  .join(' OR ')})`;

const adminSuffixes = ['市', '縣', '县', '区', '區', '省', '自治区', '自治區', '特别行政区', '特別行政區', '都', '道', '府', '県'];
const adminSuffixPattern = /(?:自治区|自治區|特别行政区|特別行政區|省|市|縣|县|区|區|都|道|府|県)$/u;

const aliases = (values: Array<string | undefined>): string[] => [...new Set(values.flatMap((value) => {
  const normalized = normalize(value);
  if (!normalized) return [];
  if (!hanScript.test(normalized)) {
    return [normalized, normalized.replace(adminSuffixPattern, '')].filter(Boolean);
  }
  // Han values match across scripts (simplified 台中 <-> traditional 臺中) and
  // across admin-suffix presence (pool stores 臺中市, catalog stores 台中).
  const scriptVariants = [...new Set([
    normalized,
    toSimplifiedHan(normalized),
    toTraditionalHongKong(normalized),
    toTraditionalTaiwan(normalized)
  ])];
  return scriptVariants.flatMap((variant) => {
    const stem = variant.replace(adminSuffixPattern, '');
    if (!stem) return [variant];
    return [variant, stem, ...adminSuffixes.map((suffix) => `${stem}${suffix}`)];
  }).filter(Boolean);
}))];

export const completenessClause = (prefix = ''): string => addressQualitySqlClause(prefix);

const residentialEvidenceClause = `EXISTS (
  SELECT 1 FROM address_pool_evidence residential_evidence
  JOIN address_datasets residential_dataset ON residential_dataset.id = residential_evidence.dataset_id
    AND residential_dataset.status = 'active' AND residential_dataset.redistribution_allowed = 1
  JOIN address_sources residential_source ON residential_source.id = residential_dataset.source_id
    AND residential_source.redistribution_allowed = 1
  WHERE residential_evidence.address_id = address_pool.id
    AND residential_evidence.evidence_type = 'residential_use'
    AND residential_evidence.is_current = 1
)`;

const aliasClause = (columns: string[], values: string[], bindings: unknown[]): string | undefined => {
  if (!values.length) return undefined;
  const placeholders = values.map(() => '?').join(',');
  return `(${columns.map((column) => {
    bindings.push(...values);
    return `${column} IN (${placeholders})`;
  }).join(' OR ')})`;
};

const fallbackComponents = (row: AddressPoolV2Row): AddressComponents => normalizeAddressComponents(row.country_code, normalizeAddressFacts(row.country_code, {
  houseNumber: row.house_number,
  street: row.street,
  ...(row.building_name ? { buildingName: row.building_name } : {}),
  locality: row.locality || row.postal_locality,
  ...(row.postal_locality ? { postalLocality: row.postal_locality } : {}),
  ...(row.district ? { district: row.district, dependentLocality: row.district } : {}),
  ...(row.admin1 ? { admin1: row.admin1 } : {}),
  ...(row.admin1_code ? { admin1Code: row.admin1_code } : {}),
  postcode: row.postcode
}));

const parseVariants = <T>(value: string, fallback: T): Record<'native' | 'en' | 'zh-CN', T> => {
  try {
    const parsed = JSON.parse(value) as Partial<Record<'native' | 'en' | 'zh-CN', T>>;
    return {
      native: parsed.native || fallback,
      en: parsed.en || parsed.native || fallback,
      'zh-CN': parsed['zh-CN'] || parsed.native || fallback
    };
  } catch {
    return { native: fallback, en: fallback, 'zh-CN': fallback };
  }
};

export const repairHongKongNativeVariants = (
  country: CountryCode,
  variants: Record<'native' | 'en' | 'zh-CN', AddressComponents>
): Record<'native' | 'en' | 'zh-CN', AddressComponents> => {
  if (country !== 'HK' && country !== 'TW') return variants;
  const nativeText = Object.values(variants.native).join(' ');
  const source = hanScript.test(nativeText) ? variants.native : variants['zh-CN'];
  if (!hanScript.test(Object.values(source).join(' '))) return variants;
  const traditionalize = country === 'HK' ? toTraditionalHongKong : toTraditionalTaiwan;
  const native = Object.fromEntries(Object.entries(source).map(([field, value]) => [
    field,
    typeof value === 'string' && nativeSemanticFields.has(field)
      ? traditionalize(value).replace(/[\p{Script=Latin}][\p{Script=Latin}\p{N}' .&/-]*/gu, ' ').replace(/\s+/gu, ' ').trim()
      : value
  ])) as unknown as AddressComponents;
  if (latinScript.test([...nativeSemanticFields].map((field) => native[field as keyof AddressComponents] || '').join(' '))) return variants;
  return { ...variants, native };
};

const storedAddress = (components: AddressComponents, country: CountryCode): string => [
  [components.houseNumber, components.street].filter(Boolean).join(' '),
  components.buildingName,
  components.unit,
  components.district || components.dependentLocality,
  components.postalLocality || components.locality,
  components.admin1Code || components.admin1,
  country === 'CN' || country === 'HK' ? '' : components.postcode
].filter(Boolean).join(', ');

const nativeStoredAddress = (components: AddressComponents, country: CountryCode): string => {
  if (country === 'HK' || country === 'TW') return [
    components.postcode,
    components.admin1,
    components.postalLocality || components.locality,
    components.district || components.dependentLocality,
    [components.houseNumber, components.street].filter(Boolean).join(' '),
    components.buildingName,
    components.unit
  ].filter(Boolean).join(', ');
  return storedAddress(components, country);
};

const rowToAddress = (row: AddressPoolV2Row, now: Date): VerifiedAddress | undefined => {
  if (!row.source_id || !row.source_name || !row.source_url) return undefined;
  if (!validateAdministrativeHierarchy({
    countryCode: row.country_code, admin1: row.admin1, admin1Code: row.admin1_code, locality: row.locality
  }).valid) return undefined;
  const fallback = fallbackComponents(row);
  const fallbackAddress = [row.house_number, row.street, row.postal_locality || row.locality, row.admin1_code || row.admin1, row.postcode]
    .filter(Boolean).join(', ');
  const parsedComponents = parseVariants(row.component_variants_json, fallback);
  for (const language of ['native', 'en', 'zh-CN'] as const) {
    const stored = parsedComponents[language];
    parsedComponents[language] = { ...fallback, ...stored };
    if (!Object.hasOwn(stored, 'dependentLocality')) {
      if (stored.district) parsedComponents[language].dependentLocality = stored.district;
      else delete parsedComponents[language].dependentLocality;
    }
  }
  const componentVariants = repairHongKongNativeVariants(row.country_code, {
    native: normalizeAddressComponents(row.country_code, normalizeAddressFacts(row.country_code, parsedComponents.native)),
    en: normalizeAddressComponents(row.country_code, normalizeAddressFacts(row.country_code, parsedComponents.en)),
    'zh-CN': normalizeAddressComponents(row.country_code, normalizeAddressFacts(row.country_code, parsedComponents['zh-CN']))
  });
  if (!storedVariantLooksLocalized(componentVariants.en, 'en')
    || !storedVariantLooksLocalized(componentVariants['zh-CN'], 'zh-CN')
    || !hasHanSemanticContent(componentVariants['zh-CN'])) return undefined;
  if (!validateAddressContract(row.country_code, componentVariants.native, { strict: true, requireAdminCode: false }).valid) return undefined;
  if (!validateAddressQuality({
    countryCode: row.country_code, components: componentVariants.native,
    latitude: row.latitude, longitude: row.longitude
  }).valid) return undefined;
  const parsedAddresses = parseVariants(row.address_variants_json, fallbackAddress);
  const addressVariants = ['HK', 'TW'].includes(row.country_code) && hanScript.test(Object.values(componentVariants.native).join(' '))
    ? {
        ...parsedAddresses,
        native: nativeStoredAddress(componentVariants.native, row.country_code)
      }
    : /^\d+[\p{L}\p{N}./-]*$/u.test(row.building_name.trim())
    ? {
        native: storedAddress(componentVariants.native, row.country_code),
        en: storedAddress(componentVariants.en, row.country_code),
        'zh-CN': storedAddress(componentVariants['zh-CN'], row.country_code)
      }
    : parsedAddresses;
  const propertyType = propertyTypes.has(row.property_type as PropertyType)
    ? row.property_type as PropertyType
    : 'unknown';
  const variants = Object.values(componentVariants);
  if (findNonResidentialMatch({
    countryCode: row.country_code,
    buildingNames: variants.map((item) => item.buildingName).filter((value): value is string => Boolean(value)),
    formattedAddresses: Object.values(addressVariants),
    streets: variants.map((item) => item.street).filter(Boolean),
    propertyType
  }).excluded) return undefined;
  if (matchesCustomBlacklist([
    ...variants.map((item) => item.buildingName),
    ...Object.values(addressVariants),
    ...variants.map((item) => item.street)
  ])) return undefined;
  const sourceUpdatedAt = row.observed_at || row.source_updated_at || row.imported_at || row.first_seen_at;
  const type = evidenceTypes.has(row.evidence_type as AddressEvidence['type'])
    ? row.evidence_type as AddressEvidence['type']
    : 'address_existence';
  const evidence: AddressEvidence[] = [{
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceUrl: row.record_url || row.source_url,
    sourceFamily: row.source_id,
    ...(row.source_license ? { sourceLicense: row.source_license } : {}),
    ...(row.license_url ? { sourceLicenseUrl: row.license_url } : {}),
    ...(row.attribution_text ? { attribution: row.attribution_text } : {}),
    ...(row.attribution_url ? { attributionUrl: row.attribution_url } : {}),
    ...(row.dataset_id ? { datasetId: row.dataset_id } : {}),
    type,
    value: addressVariants.native,
    observedAt: sourceUpdatedAt
  }];
  if (type !== 'coordinate') {
    evidence.push({
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceUrl: row.record_url || row.source_url,
      sourceFamily: row.source_id,
      type: 'coordinate',
      value: `${row.latitude},${row.longitude}`,
      observedAt: sourceUpdatedAt
    });
  }
  if (row.residential_evidence && !evidence.some(({ type: evidenceType }) => evidenceType === 'residential_use')) {
    const residentialSource = residentialEvidenceSource(row);
    evidence.push({
      ...residentialSource,
      type: 'residential_use',
      value: propertyType,
      observedAt: sourceUpdatedAt
    });
  }
  return {
    id: `pool-v2-${row.id}`,
    countryCode: row.country_code,
    nativeAddress: addressVariants.native,
    formattedAddress: addressVariants.en,
    nativeLanguage: row.country_code === 'HK' ? 'zh-HK' : row.native_language,
    addressVariants,
    components: componentVariants.native,
    componentVariants,
    coordinates: { latitude: row.latitude, longitude: row.longitude },
    addressStatus: 'verified',
    propertyType,
    unitStatus: componentVariants.native.unit ? 'verified' : componentVariants.native.buildingName ? 'building_only' : 'not_present',
    unitProvenance: componentVariants.native.unit ? 'source_tagged' : 'none',
    matchLevel: componentVariants.native.unit ? 'subpremise' : 'premise',
    verificationLevel: 'L2',
    sourceVersion: `${row.dataset_id || row.source_id}:${row.dataset_version || row.generation}`,
    sourceUpdatedAt,
    verifiedAt: now.toISOString(),
    expiresAt: '9999-12-31T23:59:59.999Z',
    evidence,
    exclusionFlags: row.quality_score < 0.7 ? ['low_quality_score'] : []
  };
};

export const storedAddressPoolV2RowIsPublishable = (
  row: AddressPoolV2Row,
  now = new Date()
): boolean => Boolean(rowToAddress(row, now))
  && (!row.expires_at || new Date(row.expires_at).getTime() > now.getTime());

const missingSchema = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (?:table|view).*(?:address_pool_runtime|address_generation_index)|(?:does not exist.*(?:address_pool_runtime|address_generation_index)|(?:address_pool_runtime|address_generation_index).*does not exist)/i.test(message);
};

interface RegionNameRow { code: string; name: string; native_name: string; zh_name: string }

const regionNameCaches = new WeakMap<object, Map<string, RegionNameRow | null>>();
const cityZhCaches = new WeakMap<object, Map<string, string | null>>();
const regionPresenceCaches = new WeakMap<object, Map<string, boolean>>();
const cacheFor = <T,>(store: WeakMap<object, Map<string, T>>, db: Database): Map<string, T> => {
  let cache = store.get(db as object);
  if (!cache) {
    cache = new Map();
    store.set(db as object, cache);
  }
  if (cache.size > 2000) cache.clear();
  return cache;
};
const han = /[\p{Script=Han}]/u;
const samePlaceKey = (value: string | undefined): string => (value || '')
  .normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, '');

const lookupRegionNames = async (
  db: Database,
  country: CountryCode,
  admin1: string,
  admin1Code: string
): Promise<RegionNameRow | null> => {
  const cache = cacheFor(regionNameCaches, db);
  const key = `${country}:${samePlaceKey(admin1Code || admin1)}`;
  if (cache.has(key)) return cache.get(key) || null;
  let row: RegionNameRow | null = null;
  try {
    const value = admin1Code || admin1;
    const raw = await db.prepare(`SELECT code, name, native_name, zh_name FROM catalog_regions
      WHERE country_code = ? AND (LOWER(code) = LOWER(?) OR LOWER(name) = LOWER(?) OR LOWER(native_name) = LOWER(?))
      ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, id LIMIT 1`)
      .bind(country, value, value, value).first<RegionNameRow>();
    row = raw && (typeof raw.name === 'string' && raw.name.trim() !== ''
      || typeof raw.native_name === 'string' && raw.native_name.trim() !== '')
      ? raw
      : null;
  } catch {
    row = null;
  }
  cache.set(key, row);
  return row;
};

const hasCatalogRegions = async (db: Database, country: CountryCode): Promise<boolean> => {
  const cache = cacheFor(regionPresenceCaches, db);
  if (cache.has(country)) return Boolean(cache.get(country));
  let present = false;
  try {
    present = Boolean(await db.prepare('SELECT 1 AS present FROM catalog_regions WHERE country_code = ? LIMIT 1')
      .bind(country).first<{ present: number }>());
  } catch {
    present = false;
  }
  cache.set(country, present);
  return present;
};

const lookupCityZhName = async (db: Database, country: CountryCode, locality: string): Promise<string | null> => {
  const cache = cacheFor(cityZhCaches, db);
  const key = `${country}:${samePlaceKey(locality)}`;
  if (cache.has(key)) return cache.get(key) || null;
  let zhName: string | null = null;
  try {
    const row = await db.prepare(`SELECT zh_name FROM catalog_cities
      WHERE country_code = ? AND (LOWER(name) = LOWER(?) OR LOWER(native_name) = LOWER(?)) AND zh_name <> ''
      ORDER BY COALESCE(population, 0) DESC, id LIMIT 1`)
      .bind(country, locality, locality).first<{ zh_name: string }>();
    zhName = typeof row?.zh_name === 'string' && han.test(row.zh_name) ? row.zh_name : null;
  } catch {
    zhName = null;
  }
  cache.set(key, zhName);
  return zhName;
};

export const enrichPickedAddress = async (db: Database, address: VerifiedAddress): Promise<VerifiedAddress> => {
  const variants = address.componentVariants;
  const updated: Record<'native' | 'en' | 'zh-CN', AddressComponents> = {
    native: { ...variants.native },
    en: { ...variants.en },
    'zh-CN': { ...variants['zh-CN'] }
  };
  const languages = ['native', 'en', 'zh-CN'] as const;
  let changed = false;

  for (const language of languages) {
    const components = updated[language];
    const houseNumber = components.houseNumber?.normalize('NFKC');
    if (houseNumber && houseNumber !== components.houseNumber) {
      components.houseNumber = houseNumber;
      changed = true;
    }
    const normalized = normalizeAddressFacts(address.countryCode, components) as AddressComponents;
    if (JSON.stringify(normalized) !== JSON.stringify(components)) {
      updated[language] = normalized;
      changed = true;
    }
  }

  const native = updated.native;
  if (native.admin1 || native.admin1Code) {
    const names = await lookupRegionNames(db, address.countryCode, native.admin1 || '', native.admin1Code || '');
    if (names) {
      const assign = (language: typeof languages[number], name: string | undefined) => {
        const value = String(name ?? '').trim();
        if (!value) return;
        if (updated[language].admin1 !== value) {
          updated[language].admin1 = value;
          changed = true;
        }
        if (names.code && updated[language].admin1Code !== names.code) {
          updated[language].admin1Code = names.code;
          changed = true;
        }
      };
      assign('native', names.native_name || names.name);
      assign('en', names.name);
      assign('zh-CN', names.zh_name || names.native_name || names.name);
    } else if ((samePlaceKey(native.admin1) === samePlaceKey(native.locality)
      || samePlaceKey(native.admin1) === samePlaceKey(native.postalLocality))
      && await hasCatalogRegions(db, address.countryCode)) {
      for (const language of languages) {
        delete updated[language].admin1;
        delete updated[language].admin1Code;
      }
      changed = true;
    }
  }

  const zhLocality = updated['zh-CN'].locality;
  if (zhLocality && !han.test(zhLocality)) {
    const zhName = await lookupCityZhName(db, address.countryCode, zhLocality);
    if (zhName) {
      updated['zh-CN'].locality = zhName;
      if (updated['zh-CN'].postalLocality && samePlaceKey(updated['zh-CN'].postalLocality) === samePlaceKey(zhLocality)) {
        updated['zh-CN'].postalLocality = zhName;
      }
      changed = true;
    }
  }

  if (address.countryCode === 'HK' && !(native.locality || '').trim()) {
    const hongKong = { native: '香港', en: 'Hong Kong', 'zh-CN': '香港' } as const;
    for (const language of languages) {
      if (!(updated[language].locality || '').trim()) {
        updated[language].locality = hongKong[language];
        changed = true;
      }
    }
  }

  // A record may carry its city only in postalLocality (or district); surface it in
  // the locality field so the city row is never blank. A postalLocality equal to
  // the street is a rural OSM duplicate, not a city.
  for (const language of languages) {
    const components = updated[language];
    if ((components.locality || '').trim()) continue;
    const postal = (components.postalLocality || '').trim();
    const substitute = postal && samePlaceKey(postal) !== samePlaceKey(components.street)
      ? postal
      : (components.district || '').trim();
    if (substitute) {
      components.locality = substitute;
      changed = true;
    }
  }

  if (!changed) return address;
  return {
    ...address,
    components: updated.native,
    componentVariants: updated
  };
};

const enrichPublishableAddress = async (db: Database, address: VerifiedAddress): Promise<VerifiedAddress | undefined> => {
  const enriched = await enrichPickedAddress(db, address);
  return requiresAdminCode(enriched.countryCode) && !enriched.components.admin1Code ? undefined : enriched;
};

const geographicDistanceKm = (
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number }
): number => {
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, value));
  return 6371 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
};

export interface NearestAddressPoolV2Result {
  address: VerifiedAddress;
  distanceKm: number;
}

export const pickNearestAddressPoolV2Address = async (
  db: Database | undefined,
  country: CountryCode,
  residential: boolean,
  coordinates: { latitude: number; longitude: number },
  seed: string,
  maximumDistanceKm = 100,
  now = new Date()
): Promise<NearestAddressPoolV2Result | undefined> => {
  if (!db) return undefined;
  const clauses = [
    'country_code = ?',
    'active = 1',
    'quality_score >= 0.7',
    completenessClause(),
    chineseVariantHasHanClause()
  ];
  const baseBindings: unknown[] = [country];
  if (residential) clauses.push(`property_type IN ('residential','apartment')`, 'residential_evidence = 1');
  const longitudeScale = Math.max(0.1, Math.cos(coordinates.latitude * Math.PI / 180));
  const radii = [...new Set([Math.min(25, maximumDistanceKm), maximumDistanceKm])].filter((radius) => radius > 0);

  try {
    for (const radiusKm of radii) {
      const latitudeRadius = radiusKm / 111.32;
      const longitudeRadius = Math.min(180, latitudeRadius / longitudeScale);
      const coordinateFilter = 'latitude >= ? AND latitude <= ? AND longitude >= ? AND longitude <= ?';
      const result = await db.prepare(`SELECT *,
        ((latitude - ?) * (latitude - ?)) +
        ((longitude - ?) * (longitude - ?) * ? * ?) AS distance_score
        FROM address_pool_runtime
        WHERE ${clauses.join(' AND ')}
          AND ${coordinateFilter}
        ORDER BY distance_score, random_key, id LIMIT 16`).bind(
        coordinates.latitude,
        coordinates.latitude,
        coordinates.longitude,
        coordinates.longitude,
        longitudeScale,
        longitudeScale,
        ...baseBindings,
        Math.max(-90, coordinates.latitude - latitudeRadius),
        Math.min(90, coordinates.latitude + latitudeRadius),
        Math.max(-180, coordinates.longitude - longitudeRadius),
        Math.min(180, coordinates.longitude + longitudeRadius)
      ).all<AddressPoolV2Row>();
      const rows = result.results || [];
      const candidates = rows.flatMap((row) => {
        const address = rowToAddress(row, now);
        return address ? [{ address, distanceKm: geographicDistanceKm(coordinates, address.coordinates) }] : [];
      }).filter((candidate) => candidate.distanceKm <= radiusKm);
      if (candidates.length) {
        const picked = candidates[hashSeed(`${country}:${seed}:ip-nearest`) % Math.min(8, candidates.length)];
        const address = await enrichPublishableAddress(db, picked.address);
        if (address) return { ...picked, address };
      }
    }
    return undefined;
  } catch (error) {
    if (missingSchema(error)) return undefined;
    throw error;
  }
};

export const loadAddressPoolV2AddressById = async (
  db: Database | undefined,
  addressId: string,
  now = new Date()
): Promise<VerifiedAddress | undefined> => {
  if (!db || !addressId.startsWith('pool-v2-')) return undefined;
  try {
    const row = await db.prepare('SELECT * FROM address_pool_runtime WHERE id = ? AND active = 1 LIMIT 1')
      .bind(addressId.slice('pool-v2-'.length).split(':')[0]).first<AddressPoolV2Row>();
    if (!row) return undefined;
    const address = rowToAddress(row, now);
    return address ? enrichPublishableAddress(db, address) : undefined;
  } catch (error) {
    if (missingSchema(error)) return undefined;
    throw error;
  }
};

export const pickAddressPoolV2Address = async (
  db: Database | undefined,
  country: CountryCode,
  residential: boolean,
  filters: AddressFilters,
  target: CatalogTarget | undefined,
  seed: string,
  now = new Date()
): Promise<VerifiedAddress | undefined> => {
  if (!db) return undefined;
  const clauses = ['country_code = ?', 'active = 1', 'quality_score >= 0.7', completenessClause(), chineseVariantHasHanClause()];
  const bindings: unknown[] = [country];
  if (residential) clauses.push(`property_type IN ('residential','apartment')`);

  const regionClause = aliasClause(
    ['admin1_key', 'admin1_code_key'],
    aliases([filters.region, target?.region, target?.regionNative, target?.regionCode, ...target?.regionAliases || []]),
    bindings
  );
  if ((filters.region || target?.region) && regionClause) clauses.push(regionClause);
  const cityClause = aliasClause(
    ['locality_key', 'postal_locality_key'],
    aliases([filters.city, target?.city, target?.cityNative, ...target?.cityAliases || []]),
    bindings
  );
  if ((filters.city || target?.city) && cityClause) clauses.push(cityClause);
  const selectedPostcode = filters.postcode || target?.postcode;
  if (selectedPostcode) {
    clauses.push('postcode_key = ?');
    bindings.push(normalize(selectedPostcode).replace(/\s/gu, ''));
  }
  if (filters.q?.trim()) {
    clauses.push(`LOWER(house_number || ' ' || street || ' ' || locality || ' ' || postal_locality || ' ' || admin1 || ' ' || postcode) LIKE ? ESCAPE '\\'`);
    bindings.push(`%${normalize(filters.q).replace(/[\\%_]/g, '\\$&')}%`);
  }

  const generationClauses = ['country_code = ?', 'active = 1'];
  const generationBindings: unknown[] = [country];
  if (residential) generationClauses.push('residential_ready = 1');
  const generationRegionClause = aliasClause(
    ['admin1_key', 'admin1_code_key'],
    aliases([filters.region, target?.region, target?.regionNative, target?.regionCode, ...target?.regionAliases || []]),
    generationBindings
  );
  if ((filters.region || target?.region) && generationRegionClause) generationClauses.push(generationRegionClause);
  const generationCityClause = aliasClause(
    ['locality_key', 'postal_locality_key'],
    aliases([filters.city, target?.city, target?.cityNative, ...target?.cityAliases || []]),
    generationBindings
  );
  if ((filters.city || target?.city) && generationCityClause) generationClauses.push(generationCityClause);
  const generationPostcode = filters.postcode || target?.postcode;
  if (generationPostcode) {
    generationClauses.push('postcode_key = ?');
    generationBindings.push(normalize(generationPostcode).replace(/\s/gu, ''));
  }
  if (filters.q?.trim()) {
    generationClauses.push(`search_text LIKE ? ESCAPE '\\'`);
    generationBindings.push(`%${normalize(filters.q).replace(/[\\%_]/g, '\\$&')}%`);
  }

  const pivot = hashSeed(`${country}:${seed}:address-pool-v2`) & 0x7fffffff;
  const candidateLimit = residential ? 16 : 64;
  try {
    const select = `SELECT id FROM address_pool WHERE ${clauses.join(' AND ')}${residential ? ` AND ${residentialEvidenceClause}` : ''}`;
    const generationSelect = `SELECT address_id AS id FROM address_generation_index WHERE ${generationClauses.join(' AND ')}`;
    const pickEligible = async (sql: string, values: unknown[]): Promise<VerifiedAddress | undefined> => {
      const identifiers = (await db.prepare(sql).bind(...values).all<{ id: string }>()).results || [];
      if (!identifiers.length) return undefined;
      const ids = identifiers.map(({ id }) => id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = (await db.prepare(`SELECT * FROM address_pool_runtime WHERE id IN (${placeholders})`)
        .bind(...ids).all<AddressPoolV2Row>()).results || [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const { id } of identifiers) {
        const row = byId.get(id);
        const address = row ? rowToAddress(row, now) : undefined;
        if (address) {
          const enriched = await enrichPublishableAddress(db, address);
          if (enriched) return enriched;
        }
      }
      return undefined;
    };
    // Test doubles and older database adapters may not expose exec(); in that
    // case use the original indexed address_pool query directly.
    if (typeof (db as { exec?: unknown }).exec === 'function') {
      const indexed = await pickEligible(`${generationSelect} AND random_key >= ? ORDER BY random_key, address_id LIMIT ${candidateLimit}`,
        [...generationBindings, pivot]);
      if (indexed) return indexed;
      const indexedFallback = await pickEligible(`${generationSelect} ORDER BY random_key, address_id LIMIT ${candidateLimit}`, generationBindings);
      if (indexedFallback) return indexedFallback;
    }
    return await pickEligible(`${select} AND random_key >= ? ORDER BY random_key, id LIMIT ${candidateLimit}`, [...bindings, pivot])
      || await pickEligible(`${select} ORDER BY random_key, id LIMIT ${candidateLimit}`, bindings);
  } catch (error) {
    if (missingSchema(error)) return undefined;
    throw error;
  }
};
