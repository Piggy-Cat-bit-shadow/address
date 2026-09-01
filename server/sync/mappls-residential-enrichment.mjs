import { isValidPostcode } from '../../src/domain/postcode-patterns.mjs';
import { pointMatchesSeedGeometry } from './google-residential-enrichment.mjs';

const text = (value) => String(value || '').trim();

export const evaluateMapplsResidentialResult = (payload, seed) => {
  if (Number(payload?.responseCode) !== 200 || !Array.isArray(payload?.results)) {
    return { record: null, reason: 'invalid_response' };
  }
  const result = payload.results[0];
  if (!result || text(result.area).toLowerCase() !== 'india') {
    return { record: null, reason: 'country_mismatch' };
  }
  if (!text(seed.number)) return { record: null, reason: 'missing_number' };
  if (!text(seed.street)) return { record: null, reason: 'missing_street' };
  const longitude = Number(result.lng);
  const latitude = Number(result.lat);
  if (!pointMatchesSeedGeometry(seed, { location: { longitude, latitude } })) {
    return { record: null, reason: 'geometry_mismatch' };
  }
  const admin1 = text(result.state);
  const locality = text(result.city || result.village || result.locality);
  const district = text(result.district || result.subDistrict);
  const postcode = text(result.pincode);
  const missing = Object.entries({ admin1, locality, district, postcode }).find(([, value]) => !value)?.[0];
  if (missing) return { record: null, reason: `missing_${missing}` };
  if (!isValidPostcode('IN', postcode)) return { record: null, reason: 'invalid_postcode' };
  return { reason: null, record: {
    id: `mappls:${seed.building_id}`,
    source_record_id: `${seed.building_id}:${payload.version || 'unknown'}`,
    source_dataset: 'OpenStreetMap residential buildings and Mappls Reverse Geocoding',
    number: text(seed.number),
    street: text(seed.street),
    admin1,
    locality,
    district,
    postcode,
    longitude,
    latitude,
    property_type: seed.building_class === 'apartments' ? 'apartment' : 'residential',
    residential_building_id: seed.building_id,
    residential_building_class: seed.building_class,
    residential_evidence: `OSM_BUILDING_MAPPLS=${seed.building_class}`
  } };
};

export const requestMapplsReverse = async ({
  latitude, longitude, credentialPool, brokerClient, fetchImpl = fetch, signal
}) => {
  if (brokerClient) {
    return brokerClient.request('mappls.reverse', { latitude, longitude }, { signal });
  }
  if (!credentialPool) throw Object.assign(new Error('No Mappls credential is configured'), {
    code: 'SOURCE_CREDENTIAL_UNAVAILABLE'
  });
  const attempted = new Set();
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const credential = await credentialPool.acquire('mappls', { excludeIds: attempted });
    if (!credential) break;
    attempted.add(credential.id);
    const url = new URL('https://search.mappls.com/search/address/rev-geocode');
    url.searchParams.set('lat', String(latitude));
    url.searchParams.set('lng', String(longitude));
    url.searchParams.set('region', 'IND');
    url.searchParams.set('access_token', credential.secret);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'address-sync/2.0' },
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
      await credentialPool.report(credential.id, response.status === 429 ? 'quota' : 'network');
      continue;
    }
    if (!response.ok) {
      await credentialPool.report(credential.id, 'invalid');
      throw Object.assign(new Error(`Mappls Reverse Geocoding returned HTTP ${response.status}`), {
        code: 'SOURCE_UPSTREAM_REJECTED'
      });
    }
    const payload = await response.json();
    if (Number(payload?.responseCode) !== 200 || !Array.isArray(payload?.results)) {
      await credentialPool.report(credential.id, 'invalid');
      continue;
    }
    await credentialPool.report(credential.id, 'success');
    return payload;
  }
  throw Object.assign(new Error('No Mappls credential is currently available'), {
    code: 'SOURCE_CREDENTIAL_UNAVAILABLE'
  });
};
