import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isValidPostcode } from '../../src/domain/postcode-patterns.mjs';

const allowedTypes = new Set(['street_address', 'premise', 'subpremise']);
const requiredComponents = {
  IN: ['admin1', 'locality', 'district', 'postcode'],
  NG: ['admin1', 'locality', 'district', 'postcode'],
  PH: ['admin1', 'locality', 'district', 'postcode'],
  SA: ['locality', 'district', 'postcode'],
  TH: ['admin1', 'locality', 'district', 'postcode'],
  TR: ['admin1', 'locality', 'district', 'postcode'],
  VN: ['admin1', 'locality', 'postcode']
};

export const googleResidentialLanguages = Object.freeze({
  IN: 'en', NG: 'en', PH: 'en', SA: 'ar', TH: 'th', TR: 'tr', VN: 'vi'
});

const component = (result, ...types) => {
  for (const type of types) {
    const match = result.addressComponents?.find((entry) => entry.types?.includes(type));
    if (match?.longText || match?.long_name) return String(match.longText || match.long_name).trim();
  }
  return '';
};

const normalizeDecimalDigits = (value) => String(value || '').replace(/[\u0660-\u0669\u06f0-\u06f9\uff10-\uff19]/gu, (digit) => {
  const code = digit.codePointAt(0);
  const zero = code >= 0xff10 ? 0xff10 : code >= 0x06f0 ? 0x06f0 : 0x0660;
  return String(code - zero);
});

const country = (result) => String(result.postalAddress?.regionCode || result.addressComponents
  ?.find((entry) => entry.types?.includes('country'))?.shortText
  || result.addressComponents?.find((entry) => entry.types?.includes('country'))?.short_name || '').toUpperCase();

const pointInRing = (longitude, latitude, ring) => {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  let inside = false;
  let previous = ring.at(-1);
  for (const current of ring) {
    if (!Array.isArray(current) || !Array.isArray(previous)) return false;
    const [x1, y1] = previous.map(Number);
    const [x2, y2] = current.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return false;
    const cross = (longitude - x1) * (y2 - y1) - (latitude - y1) * (x2 - x1);
    if (Math.abs(cross) <= 1e-12 && Math.min(x1, x2) <= longitude && longitude <= Math.max(x1, x2)
      && Math.min(y1, y2) <= latitude && latitude <= Math.max(y1, y2)) return true;
    if ((y1 > latitude) !== (y2 > latitude)) {
      const crossing = (x2 - x1) * (latitude - y1) / (y2 - y1) + x1;
      if (longitude < crossing) inside = !inside;
    }
    previous = current;
  }
  return inside;
};

const metersBetween = (left, right) => {
  const latitude = (Number(left.latitude) + Number(right.latitude)) * Math.PI / 360;
  const x = (Number(left.longitude) - Number(right.longitude)) * Math.PI / 180 * Math.cos(latitude);
  const y = (Number(left.latitude) - Number(right.latitude)) * Math.PI / 180;
  return Math.hypot(x, y) * 6_371_000;
};

export const pointMatchesSeedGeometry = (seed, result) => {
  const longitude = Number(result.location?.longitude ?? result.geometry?.location?.lng);
  const latitude = Number(result.location?.latitude ?? result.geometry?.location?.lat);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  if (pointInRing(longitude, latitude, seed.ring)) return true;
  return metersBetween(seed, { longitude, latitude }) <= 15;
};

const addressParts = (result, countryCode) => {
  const postcodeCandidates = [
    result.postalAddress?.postalCode,
    ...(result.addressComponents || [])
      .filter((entry) => entry.types?.includes('postal_code'))
      .map((entry) => entry.longText || entry.long_name)
  ].map((value) => normalizeDecimalDigits(value).trim()).filter(Boolean);
  return {
    number: normalizeDecimalDigits(component(result, 'street_number')),
    street: component(result, 'route'),
    admin1: component(result, 'administrative_area_level_1'),
    locality: component(result, 'locality', 'postal_town', 'administrative_area_level_2'),
    district: component(result, 'sublocality_level_1', 'administrative_area_level_3',
      ...(countryCode === 'TR' ? ['administrative_area_level_4'] : []), 'neighborhood'),
    postcode: postcodeCandidates.find((value) => isValidPostcode(countryCode, value)) || postcodeCandidates[0] || ''
  };
};

const normalizeResult = (raw) => raw.placeId ? raw : {
  ...raw,
  placeId: raw.place_id,
  partialMatch: raw.partial_match,
  granularity: raw.geometry?.location_type,
  location: {
    latitude: raw.geometry?.location?.lat,
    longitude: raw.geometry?.location?.lng
  },
  addressComponents: (raw.address_components || []).map((entry) => ({
    ...entry, longText: entry.longText || entry.long_name, shortText: entry.shortText || entry.short_name
  })),
  postalAddress: {
    regionCode: raw.address_components?.find((entry) => entry.types?.includes('country'))?.short_name,
    postalCode: raw.address_components?.find((entry) => entry.types?.includes('postal_code'))?.long_name
  }
};

const supplementAdministrativeParts = (base, results, countryCode) => {
  const complete = { ...base };
  for (const result of results) {
    if (country(result) !== countryCode) continue;
    const candidate = addressParts(result, countryCode);
    for (const name of ['admin1', 'locality', 'district', 'postcode']) {
      if (!complete[name] && candidate[name]) complete[name] = candidate[name];
    }
  }
  return complete;
};

export const evaluateGoogleResidentialResult = (payload, seed, countryCode) => {
  if (!Array.isArray(payload?.results) || (payload.status && payload.status !== 'OK')) {
    return { record: null, reason: 'invalid_response' };
  }
  const results = payload.results.map(normalizeResult);
  let reason = results.length ? 'no_exact_address' : 'no_results';
  for (const result of results) {
    if (!result.placeId || result.partialMatch) continue;
    if (country(result) !== countryCode) {
      reason = 'country_mismatch';
      continue;
    }
    const resultType = result.types?.find((type) => allowedTypes.has(type));
    const locationType = String(result.granularity || '');
    if (!resultType) {
      reason = 'unsupported_address_type';
      continue;
    }
    if (locationType !== 'ROOFTOP'
      && !(locationType === 'GEOMETRIC_CENTER' && ['premise', 'subpremise'].includes(resultType))) {
      reason = 'insufficient_geometry_precision';
      continue;
    }
    if (!pointMatchesSeedGeometry(seed, result)) {
      reason = 'geometry_mismatch';
      continue;
    }
    const parts = supplementAdministrativeParts(addressParts(result, countryCode), results, countryCode);
    const missing = ['number', 'street', ...(requiredComponents[countryCode] || [])]
      .find((name) => !parts[name]);
    if (missing) {
      reason = `missing_${missing}`;
      continue;
    }
    if (!isValidPostcode(countryCode, parts.postcode)) {
      reason = 'invalid_postcode';
      continue;
    }
    return { reason: null, record: {
      id: `google:${result.placeId}`,
      source_record_id: `${seed.building_id}:${result.placeId}`,
      source_dataset: 'OpenStreetMap residential buildings and Google Geocoding',
      number: parts.number,
      street: parts.street,
      admin1: parts.admin1,
      locality: parts.locality,
      district: parts.district,
      postcode: parts.postcode,
      longitude: Number(result.location.longitude),
      latitude: Number(result.location.latitude),
      property_type: seed.building_class === 'apartments' ? 'apartment' : 'residential',
      residential_building_id: seed.building_id,
      residential_building_class: seed.building_class,
      residential_evidence: `OSM_BUILDING_GOOGLE=${seed.building_class}:${locationType}`
    } };
  }
  return { record: null, reason };
};

export const selectGoogleResidentialResult = (payload, seed, countryCode) =>
  evaluateGoogleResidentialResult(payload, seed, countryCode).record;

const retryableCodes = new Set([
  'SOURCE_CREDENTIAL_UNAVAILABLE', 'SOURCE_QUOTA_UNAVAILABLE', 'SOURCE_RATE_LIMITED',
  'BROKER_TEST_POLICY_BLOCKED', 'BROKER_UNAVAILABLE'
]);
const inlineRateLimitAttempts = 8;
const maximumInlineRateLimitWaitMs = 5_000;

const waitFor = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(Object.assign(new Error('Google Geocoding request aborted'), { code: 'SYNC_PROCESS_ABORTED' }));
    return;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(Object.assign(new Error('Google Geocoding request aborted'), { code: 'SYNC_PROCESS_ABORTED' }));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, milliseconds);
  signal?.addEventListener('abort', onAbort, { once: true });
});

export const reconcileGoogleProgressOutput = async (output, progress) => {
  const accepted = Number(progress?.accepted);
  if (!Number.isSafeInteger(accepted) || accepted < 0) return false;
  let content;
  try { content = await readFile(output, 'utf8'); }
  catch (error) { return error?.code === 'ENOENT' && accepted === 0; }
  const lines = content.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length < accepted) return false;
  const retained = lines.slice(0, accepted);
  const identifiers = new Set();
  try {
    for (const line of retained) {
      const identifier = String(JSON.parse(line).source_record_id || '');
      if (!identifier || identifiers.has(identifier)) return false;
      identifiers.add(identifier);
    }
  } catch {
    return false;
  }
  if (lines.length !== accepted) {
    const temporary = `${output}.${process.pid}.reconcile.tmp`;
    try {
      await writeFile(temporary, retained.length ? `${retained.join('\n')}\n` : '', 'utf8');
      await rename(temporary, output);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return true;
};

export const requestGoogleReverse = async ({
  latitude, longitude, language, regionCode = '', credentialPool, brokerClient, fetchImpl = fetch, signal
}) => {
  if (brokerClient) {
    for (let attempt = 0; attempt < inlineRateLimitAttempts; attempt += 1) {
      try {
        return await brokerClient.request('google-geocoding.reverse', {
          latitude, longitude, language, regionCode
        }, { signal });
      } catch (error) {
        const waitMilliseconds = Date.parse(error?.retryAt || '') - Date.now();
        if (error?.code !== 'SOURCE_RATE_LIMITED' || attempt + 1 >= inlineRateLimitAttempts
          || !Number.isFinite(waitMilliseconds)
          || waitMilliseconds > maximumInlineRateLimitWaitMs) throw error;
        await waitFor(Math.max(1, waitMilliseconds + 25), signal);
      }
    }
  }
  if (!credentialPool) throw Object.assign(new Error('No Google Geocoding credential is configured'), {
    code: 'SOURCE_CREDENTIAL_UNAVAILABLE'
  });
  const attempted = new Set();
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const credential = await credentialPool.acquire('google-geocoding', { excludeIds: attempted });
    if (!credential) break;
    attempted.add(credential.id);
    const url = new URL('https://geocode.googleapis.com/v4/geocode/location');
    url.searchParams.set('location.latitude', String(latitude));
    url.searchParams.set('location.longitude', String(longitude));
    url.searchParams.set('languageCode', language);
    if (regionCode) url.searchParams.set('regionCode', regionCode.toUpperCase());
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json', 'User-Agent': 'address-sync/2.0',
          'X-Goog-Api-Key': credential.secret,
          'X-Goog-FieldMask': 'results.placeId,results.types,results.addressComponents,results.postalAddress,results.location,results.granularity'
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
      });
    } catch (error) {
      if (signal?.aborted) throw Object.assign(error, { code: 'SYNC_PROCESS_ABORTED' });
      await credentialPool.report(credential.id, 'network');
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await credentialPool.report(credential.id, 'auth');
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await credentialPool.report(credential.id, response.status === 429 ? 'qps' : 'network');
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(`Google Geocoding returned HTTP ${response.status}`), {
      code: 'SOURCE_UPSTREAM_REJECTED'
    });
    const payload = await response.json();
    if (payload?.error) {
      await credentialPool.report(credential.id, 'auth');
      continue;
    }
    await credentialPool.report(credential.id, 'success');
    return payload;
  }
  const error = Object.assign(new Error('No Google Geocoding credential is currently available'), {
    code: 'SOURCE_CREDENTIAL_UNAVAILABLE'
  });
  if (retryableCodes.has(error.code)) throw error;
  throw error;
};
