import type { AddressComponents, AddressEvidence, CountryConfig, PropertyType, VerifiedAddress } from '../../../src/domain/types';
import { gcj02ToWgs84 } from '../../../src/domain/coordinates';
import { findNonResidentialMatch } from '../../../src/domain/non-residential.mjs';
import { filterCandidates, type AddressFilters, type CatalogTarget } from '../repositories/address-repository';
import { fetchWithTimeout } from './fetch-timeout';
import { fetchHongKongAlsCandidates } from './hong-kong-als';

const DAY = 24 * 60 * 60 * 1000;
const geoapifyCountryCode = (country: CountryConfig): string => country.code === 'HK' ? 'cn' : country.code.toLowerCase();
const matchesGeoapifyCountry = (country: CountryConfig, code: string | undefined): boolean =>
  code?.toUpperCase() === country.code || (country.code === 'HK' && code?.toUpperCase() === 'CN');

export type LocationField = 'region' | 'city' | 'postcode';
export interface ExternalLocationResult { regions: string[]; cities: string[]; postcodes: string[]; matches: string[] }

const unique = (values: Array<string | undefined>): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))];
const normalizedPlace = (value = ''): string => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
  .replace(/\b(prefecture|province|state|region)\b/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
const targetName = (value: string | undefined, aliases: string[] | undefined, native: string | undefined): string | undefined =>
  value && native && aliases?.some((alias) => normalizedPlace(alias) === normalizedPlace(value)) ? native : value;

const addressFromSource = (
  country: CountryConfig,
  source: { id: string; name: string; url: string },
  components: AddressComponents,
  coordinates: { latitude: number; longitude: number },
  formatted: string,
  now: Date,
  detectedPropertyType?: PropertyType,
  recordId?: string,
  classifications: string[] = [],
  residentialEvidence?: string
): VerifiedAddress | undefined => {
  if (!components.street || !components.locality || !formatted) return undefined;
  const observedAt = now.toISOString();
  const evidence: AddressEvidence[] = [
    { sourceId: source.id, sourceName: source.name, sourceUrl: source.url, sourceFamily: source.id, type: 'address_existence', value: formatted, observedAt },
    { sourceId: source.id, sourceName: source.name, sourceUrl: source.url, sourceFamily: source.id, type: 'coordinate', value: `${coordinates.latitude},${coordinates.longitude}`, observedAt }
  ];
  if (residentialEvidence) {
    evidence.push({ sourceId: source.id, sourceName: source.name, sourceUrl: source.url, sourceFamily: source.id, type: 'residential_use', value: residentialEvidence, observedAt });
  }
  if (detectedPropertyType === 'apartment') {
    evidence.push({ sourceId: source.id, sourceName: source.name, sourceUrl: source.url, sourceFamily: source.id, type: 'building_status', value: 'provider multi-unit building tag', observedAt });
  }
  const propertyType: PropertyType = detectedPropertyType || 'unknown';
  if (findNonResidentialMatch({
    countryCode: country.code,
    buildingName: components.buildingName,
    formattedAddress: formatted,
    street: components.street,
    propertyType,
    classifications
  }).excluded) return undefined;
  const sourcePathId = new URL(source.url).pathname.split('/').filter(Boolean).pop();
  const sourceRecordId = recordId || sourcePathId || formatted;
  return {
    id: `${source.id}-${country.code.toLowerCase()}-${source.id === 'geoapify' || !sourcePathId ? encodeURIComponent(sourceRecordId) : sourceRecordId}`,
    countryCode: country.code,
    nativeAddress: formatted,
    formattedAddress: formatted,
    nativeLanguage: country.nativeLanguage,
    addressVariants: { native: formatted, en: formatted, 'zh-CN': formatted },
    components,
    componentVariants: { native: components, en: components, 'zh-CN': components },
    coordinates,
    addressStatus: 'verified', propertyType, unitStatus: 'building_only', matchLevel: 'premise', verificationLevel: 'L2',
    sourceVersion: `${source.id}-${now.toISOString().slice(0, 10)}`,
    sourceUpdatedAt: observedAt, verifiedAt: observedAt,
    expiresAt: new Date(now.getTime() + 7 * DAY).toISOString(), evidence, exclusionFlags: []
  };
};

interface GeoapifyFeature {
  properties?: {
    place_id?: string; name?: string; housenumber?: string; street?: string; city?: string; town?: string; village?: string;
    suburb?: string; district?: string; county?: string; state?: string; state_code?: string; postcode?: string; formatted?: string; lat?: number; lon?: number; country_code?: string;
    categories?: string[];
    datasource?: { raw?: Record<string, unknown> };
  };
}

const fetchGeoapify = async (
  country: CountryConfig,
  residential: boolean,
  filters: AddressFilters,
  apiKey: string,
  fetcher: typeof fetch,
  now: Date,
  target?: CatalogTarget,
  timeoutMs = 6500
): Promise<VerifiedAddress[]> => {
  let center = target?.coordinates || country.fallbackCenter;
  const place = filters.postcode || filters.city || filters.region;
  if (place && !target) {
    const search = new URL('https://api.geoapify.com/v1/geocode/search');
    search.searchParams.set('text', `${place}, ${country.name.en}`);
    search.searchParams.set('filter', `countrycode:${geoapifyCountryCode(country)}`);
    search.searchParams.set('limit', '1');
    search.searchParams.set('apiKey', apiKey);
    const response = await fetchWithTimeout(fetcher, search, { headers: { Accept: 'application/json' } }, timeoutMs);
    if (response.ok) {
      const body = await response.json() as { features?: GeoapifyFeature[] };
      const point = body.features?.[0]?.properties;
      if (point?.lat !== undefined && point.lon !== undefined) center = { latitude: point.lat, longitude: point.lon };
    }
  }
  const source = { id: 'geoapify', name: 'Geoapify / OpenStreetMap', url: 'https://www.geoapify.com/' };
  const places = async (category: string, radius: number): Promise<VerifiedAddress[]> => {
    const url = new URL('https://api.geoapify.com/v2/places');
    url.searchParams.set('categories', category);
    url.searchParams.set('filter', `circle:${center.longitude},${center.latitude},${radius}`);
    url.searchParams.set('bias', `proximity:${center.longitude},${center.latitude}`);
    url.searchParams.set('limit', '20');
    url.searchParams.set('apiKey', apiKey);
    const response = await fetchWithTimeout(fetcher, url, { headers: { Accept: 'application/json' } }, timeoutMs);
    if (!response.ok) return [];
    const body = await response.json() as { features?: GeoapifyFeature[] };
    const candidates = (body.features || []).map(({ properties: item }) => {
      if (!item || !matchesGeoapifyCountry(country, item.country_code) || item.lat === undefined || item.lon === undefined) return undefined;
      const components: AddressComponents = {
        houseNumber: item.housenumber || '', street: item.street || item.suburb || item.district || String(item.name || ''), buildingName: item.name ? String(item.name) : undefined,
        locality: targetName(item.city || item.town || item.village, target?.cityAliases, target?.cityNative) || item.suburb || item.district || '',
        postalLocality: targetName(item.city || item.town || item.village, target?.cityAliases, target?.cityNative),
        dependentLocality: item.suburb || item.district,
        district: item.county || item.district,
        admin1: targetName(item.state, target?.regionAliases, target?.regionNative),
        admin1Code: item.state_code || target?.regionCode,
        postcode: item.postcode || ''
      };
      const formatted = country.code === 'HK' ? (item.formatted || '').replace(/, China$/i, ', Hong Kong') : item.formatted || '';
      const raw = item.datasource?.raw || {};
      const building = String(raw.building || '').toLocaleLowerCase();
      const units = Number(raw['building:units'] || 0);
      const detectedType: PropertyType = ['apartments', 'dormitory'].includes(building) || units > 1
        ? 'apartment'
        : residential ? 'residential' : 'unknown';
      const classifications = [building, ...(item.categories || [])]
        .flatMap((value) => [value, ...value.split(/[.:/]/u)])
        .filter(Boolean);
      const residentialEvidence = ['apartments', 'house', 'residential', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'dormitory'].includes(building)
        ? `building=${building}` : undefined;
      return addressFromSource(country, source, components, { latitude: item.lat, longitude: item.lon }, formatted, now, detectedType, item.place_id, classifications, residentialEvidence);
    }).filter((item): item is VerifiedAddress => Boolean(item));
    const filtered = filterCandidates(candidates, filters, target);
    const numbered = filtered.filter((candidate) => candidate.components.houseNumber);
    return numbered.length ? numbered : filtered;
  };
  const candidates = await places(residential ? 'building.residential' : 'building', 8000);
  if (candidates.length || residential) return candidates;
  return places('accommodation', 12000);
};

interface OneMapResult {
  SEARCHVAL?: string; BLK_NO?: string; ROAD_NAME?: string; BUILDING?: string; ADDRESS?: string; POSTAL?: string;
  LATITUDE?: string; LONGITUDE?: string;
}

const oneMapValue = (value: string | undefined): string => value && value.toUpperCase() !== 'NIL' ? value : '';

interface AmapPoi {
  id?: string; name?: string; address?: string | string[]; location?: string; pname?: string; cityname?: string; adname?: string;
  type?: string; typecode?: string;
}

const amapStreetAddress = (item: AmapPoi, address: string): {
  street: string;
  houseNumber: string;
} | undefined => {
  let localAddress = address.trim();
  for (const administrative of unique([item.pname, item.cityname, item.adname])) {
    if (localAddress.startsWith(administrative)) localAddress = localAddress.slice(administrative.length);
  }
  const numbered = localAddress.match(/^(.+?(?:大道|大街|公路|路|街|巷|道|弄))(\d+(?:-\d+)?(?:号|弄|巷))(.*)$/u);
  if (numbered?.[1]) {
    return { street: numbered[1].trim(), houseNumber: numbered[2] };
  }
  return undefined;
};

const fetchAmap = async (
  country: CountryConfig,
  filters: AddressFilters,
  apiKey: string,
  fetcher: typeof fetch,
  now: Date,
  target?: CatalogTarget,
  timeoutMs = 6500
): Promise<VerifiedAddress[]> => {
  const catalogCity = target?.cityAliases.find((value) => /[\u3400-\u9fff]/u.test(value)) || target?.city;
  const url = new URL('https://restapi.amap.com/v3/place/text');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('keywords', '住宅小区');
  url.searchParams.set('city', catalogCity || filters.city || filters.region || target?.region || '北京市');
  url.searchParams.set('citylimit', 'true');
  url.searchParams.set('types', '120302');
  url.searchParams.set('offset', '25');
  url.searchParams.set('extensions', 'all');
  const response = await fetchWithTimeout(fetcher, url, { headers: { Accept: 'application/json' } }, timeoutMs);
  if (!response.ok) return [];
  const body = await response.json() as { status?: string; pois?: AmapPoi[] };
  if (body.status !== '1') return [];
  const candidates = (body.pois || []).map((item) => {
    if (item.typecode !== '120302' && !item.type?.includes('住宅小区')) return undefined;
    const address = Array.isArray(item.address) ? item.address[0] || '' : item.address || '';
    const [longitude, latitude] = (item.location || '').split(',').map(Number);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
    const streetAddress = amapStreetAddress(item, address);
    if (!streetAddress) return undefined;
    const components: AddressComponents = {
      houseNumber: streetAddress.houseNumber, street: streetAddress.street, buildingName: item.name,
      locality: item.cityname || '', district: item.adname, admin1: item.pname, postcode: ''
    };
    const source = { id: 'amap', name: '高德地图', url: item.id ? `https://www.amap.com/place/${item.id}` : 'https://www.amap.com/' };
    const administrative = [item.pname, item.cityname, item.adname].filter((value, index, values) => value && values.indexOf(value) === index).join('');
    const formatted = `${administrative}${streetAddress.street}${streetAddress.houseNumber}${item.name || ''}`;
    return addressFromSource(country, source, components, gcj02ToWgs84(latitude, longitude), formatted, now, 'apartment', item.id, [], 'amap:typecode=120302');
  }).filter((item): item is VerifiedAddress => Boolean(item));
  return filterCandidates(candidates, filters, target);
};

const fetchOneMap = async (
  country: CountryConfig,
  filters: AddressFilters,
  token: string,
  fetcher: typeof fetch,
  now: Date,
  target?: CatalogTarget,
  timeoutMs = 6500
): Promise<VerifiedAddress[]> => {
  const searchValue = filters.postcode || filters.city || filters.region || target?.postcode || target?.city || 'Ang Mo Kio';
  const url = new URL('https://www.onemap.gov.sg/api/common/elastic/search');
  url.searchParams.set('searchVal', searchValue);
  url.searchParams.set('returnGeom', 'Y');
  url.searchParams.set('getAddrDetails', 'Y');
  url.searchParams.set('pageNum', '1');
  const response = await fetchWithTimeout(fetcher, url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, timeoutMs);
  if (!response.ok) return [];
  const body = await response.json() as { results?: OneMapResult[] };
  const source = { id: 'onemap', name: 'Singapore OneMap', url: 'https://www.onemap.gov.sg/' };
  const candidates = (body.results || []).map((item) => {
    const latitude = Number(item.LATITUDE); const longitude = Number(item.LONGITUDE);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
    const components: AddressComponents = {
      houseNumber: oneMapValue(item.BLK_NO), street: oneMapValue(item.ROAD_NAME), buildingName: oneMapValue(item.BUILDING) || undefined,
      locality: 'Singapore', postalLocality: 'Singapore', admin1: 'Singapore', postcode: oneMapValue(item.POSTAL)
    };
    const recordId = oneMapValue(item.POSTAL)
      || [oneMapValue(item.BLK_NO), oneMapValue(item.ROAD_NAME), item.LATITUDE, item.LONGITUDE].filter(Boolean).join(':');
    return addressFromSource(country, source, components, { latitude, longitude }, item.ADDRESS || item.SEARCHVAL || '', now, undefined, recordId);
  }).filter((item): item is VerifiedAddress => Boolean(item));
  return filterCandidates(candidates, filters, target);
};

export const searchExternalLocations = async (
  country: CountryConfig,
  field: LocationField,
  query: string,
  region: string | undefined,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch
): Promise<ExternalLocationResult> => {
  const empty: ExternalLocationResult = { regions: [], cities: [], postcodes: [], matches: [] };
  if (!apiKey || query.trim().length < 2) return empty;
  const url = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
  url.searchParams.set('text', [query.trim(), region, country.name.en].filter(Boolean).join(', '));
  url.searchParams.set('filter', `countrycode:${geoapifyCountryCode(country)}`);
  url.searchParams.set('type', field === 'region' ? 'state' : field === 'postcode' ? 'postcode' : 'city');
  url.searchParams.set('limit', '40');
  url.searchParams.set('format', 'json');
  url.searchParams.set('apiKey', apiKey);
  const response = await fetchWithTimeout(fetcher, url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return empty;
  const payload = await response.json() as { results?: Array<{ state?: string; city?: string; town?: string; village?: string; postcode?: string }> };
  const regions = unique((payload.results || []).map((item) => item.state));
  const cities = unique((payload.results || []).map((item) => item.city || item.town || item.village));
  const postcodes = unique((payload.results || []).map((item) => item.postcode));
  const matches = field === 'region' ? regions : field === 'city' ? cities : postcodes;
  return { regions, cities, postcodes, matches };
};

export const listExternalCities = async (
  country: CountryConfig,
  region: string,
  residential: boolean,
  keys: Pick<ExternalProviderKeys, 'geoapify' | 'amap'>,
  fetcher: typeof fetch = fetch
): Promise<string[]> => {
  if (country.code === 'CN' && keys.amap) {
    const url = new URL('https://restapi.amap.com/v3/config/district');
    url.searchParams.set('key', keys.amap);
    url.searchParams.set('keywords', region);
    url.searchParams.set('subdistrict', '1');
    url.searchParams.set('extensions', 'base');
    const response = await fetchWithTimeout(fetcher, url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return [];
    const payload = await response.json() as { status?: string; districts?: Array<{ districts?: Array<{ name?: string; level?: string }> }> };
    if (payload.status !== '1') return [];
    return unique((payload.districts?.[0]?.districts || []).filter((item) => ['city', 'district'].includes(item.level || '')).map((item) => item.name));
  }
  if (!keys.geoapify) return [];
  const search = new URL('https://api.geoapify.com/v1/geocode/search');
  search.searchParams.set('text', `${region}, ${country.name.en}`);
  search.searchParams.set('filter', `countrycode:${geoapifyCountryCode(country)}`);
  search.searchParams.set('type', 'state');
  search.searchParams.set('limit', '1');
  search.searchParams.set('apiKey', keys.geoapify);
  const searchResponse = await fetchWithTimeout(fetcher, search, { headers: { Accept: 'application/json' } });
  if (!searchResponse.ok) return [];
  const searchPayload = await searchResponse.json() as { features?: GeoapifyFeature[] };
  const placeId = searchPayload.features?.[0]?.properties?.place_id;
  if (!placeId) return [];
  const places = new URL('https://api.geoapify.com/v2/places');
  places.searchParams.set('categories', residential
    ? 'building.residential'
    : 'populated_place.city');
  places.searchParams.set('filter', `place:${placeId}`);
  places.searchParams.set('limit', '500');
  places.searchParams.set('apiKey', keys.geoapify);
  const placesResponse = await fetchWithTimeout(fetcher, places, { headers: { Accept: 'application/json' } });
  if (!placesResponse.ok) return [];
  const placesPayload = await placesResponse.json() as { features?: GeoapifyFeature[] };
  return unique((placesPayload.features || []).map(({ properties }) => residential
    ? properties?.city || properties?.town || properties?.village
    : properties?.name || properties?.city || properties?.town || properties?.village));
};

export interface ExternalProviderKeys {
  geoapify?: string;
  amap?: string;
  oneMap?: string;
  osDataHub?: string;
}

export const fetchExternalCandidates = async (
  country: CountryConfig,
  residential: boolean,
  filters: AddressFilters,
  keys: ExternalProviderKeys,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  target?: CatalogTarget,
  timeoutMs = 6500
): Promise<{ candidates: VerifiedAddress[]; sources: string[] }> => {
  const attempt = async (provider: () => Promise<VerifiedAddress[]>): Promise<VerifiedAddress[]> => {
    for (let index = 0; index < 2; index += 1) {
      try {
        const candidates = await provider();
        const eligible = candidates.filter((candidate) => candidate.addressStatus === 'verified'
          && (!residential || candidate.evidence.some((item) => item.type === 'residential_use')));
        if (eligible.length) return eligible;
      } catch {
        if (index === 1) return [];
      }
    }
    return [];
  };
  if (country.code === 'CN' && keys.amap) {
    const candidates = await attempt(() => fetchAmap(country, filters, keys.amap!, fetcher, now, target, timeoutMs));
    if (candidates.length) return { candidates, sources: ['amap'] };
    return { candidates: [], sources: ['amap'] };
  }
  if (country.code === 'HK') {
    const candidates = await attempt(() => fetchHongKongAlsCandidates(country, residential, filters, fetcher, now, target));
    if (candidates.length) return { candidates, sources: ['hk-als'] };
  }
  if (country.code === 'SG' && !residential && keys.oneMap) {
    const candidates = await attempt(() => fetchOneMap(country, filters, keys.oneMap!, fetcher, now, target, timeoutMs));
    if (candidates.length) return { candidates, sources: ['onemap'] };
  }
  if (keys.geoapify) {
    const candidates = await attempt(() => fetchGeoapify(country, residential, filters, keys.geoapify!, fetcher, now, target, timeoutMs));
    if (candidates.length) return { candidates, sources: ['geoapify'] };
  }
  return { candidates: [], sources: [] };
};
