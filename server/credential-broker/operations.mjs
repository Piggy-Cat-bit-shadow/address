const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

const exactKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.has(key));
const finite = (value, minimum, maximum) => Number.isFinite(value) && value >= minimum && value <= maximum;
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const nextPeriod = (period, offsetMinutes = 480) => {
  const shifted = new Date(Date.now() + offsetMinutes * 60_000);
  if (period === 'month') shifted.setUTCMonth(shifted.getUTCMonth() + 1, 1);
  else shifted.setUTCDate(shifted.getUTCDate() + 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMinutes * 60_000).toISOString();
};

const geoapifyReverse = (value) => {
  if (!exactKeys(value, new Set(['latitude', 'longitude', 'language']))
    || !finite(value.latitude, -90, 90) || !finite(value.longitude, -180, 180)) return null;
  const language = value.language === undefined ? 'ko' : String(value.language);
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(language)) return null;
  return { latitude: value.latitude, longitude: value.longitude, language };
};

const googleReverse = (value) => {
  if (!exactKeys(value, new Set(['latitude', 'longitude', 'language', 'regionCode']))
    || !finite(value.latitude, -90, 90) || !finite(value.longitude, -180, 180)) return null;
  const language = String(value.language || 'en');
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(language)) return null;
  const regionCode = value.regionCode === undefined ? '' : String(value.regionCode).toUpperCase();
  if (regionCode && !/^[A-Z]{2}$/u.test(regionCode)) return null;
  return { latitude: value.latitude, longitude: value.longitude, language, regionCode };
};

const mapplsNearby = (value) => {
  if (!exactKeys(value, new Set(['latitude', 'longitude', 'categoryCode', 'radius', 'page']))
    || !finite(value.latitude, 6, 38) || !finite(value.longitude, 67, 98)
    || !/^[A-Za-z0-9,_-]{1,120}$/u.test(String(value.categoryCode || ''))
    || !integer(value.radius, 1, 50_000) || !integer(value.page, 1, 100)) return null;
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    categoryCode: String(value.categoryCode),
    radius: value.radius,
    page: value.page
  };
};

const mapplsEntity = (value) => exactKeys(value, new Set(['eLoc']))
  && /^[A-Za-z0-9_-]{1,128}$/u.test(String(value.eLoc || '')) ? { eLoc: String(value.eLoc) } : null;

const chinaPlace = (value) => {
  if (!exactKeys(value, new Set(['region', 'page', 'subdivision']))
    || !/^.{1,100}$/u.test(String(value.region || ''))
    || !integer(value.page, 1, 100)
    || !/^.{0,100}$/u.test(String(value.subdivision || ''))) return null;
  return { region: String(value.region), page: value.page, subdivision: String(value.subdivision || '') };
};

const onemapSearch = (value) => exactKeys(value, new Set(['searchVal']))
  && /^.{1,160}$/u.test(String(value.searchVal || '')) ? { searchVal: String(value.searchVal) } : null;

const providerFailure = (outcome, retryAt = null) => outcome === 'invalid'
  ? { type: 'error', outcome: 'request', status: 502, code: 'UPSTREAM_REQUEST_REJECTED' }
  : { type: 'retry', outcome, retryAt };

const classifyAmap = (body) => {
  if (body?.status === '1') return null;
  const code = String(body?.infocode || '');
  const outcome = ['10003', '10044', '10045', '40000'].includes(code) ? 'quota'
    : ['10004', '10014', '10015', '10019', '10020', '10021', '10029'].includes(code) ? 'qps'
      : ['10001', '10002', '10005', '10006', '10007', '10008', '10009', '10010', '10011', '10012', '10013', '10026', '10041'].includes(code) ? 'auth'
        : 'invalid';
  const retryAt = outcome === 'quota' ? nextPeriod(code === '40000' ? 'month' : 'day')
    : outcome === 'qps' ? new Date(Date.now() + 2_000).toISOString() : null;
  return providerFailure(outcome, retryAt);
};

const classifyTencent = (body) => {
  if (body?.status === 0) return null;
  const status = Number(body?.status);
  const outcome = status === 120 ? 'qps' : status === 121 ? 'quota'
    : [110, 111, 112].includes(status) ? 'auth' : 'invalid';
  return providerFailure(outcome, outcome === 'quota' ? nextPeriod('day')
    : outcome === 'qps' ? new Date(Date.now() + 2_000).toISOString() : null);
};

const classifyBaidu = (body) => {
  if (body?.status === 0) return null;
  const status = Number(body?.status);
  const outcome = [4, 302].includes(status) ? 'quota' : status === 301 ? 'qps'
    : [101, 102, 200, 201].includes(status) ? 'auth' : 'invalid';
  return providerFailure(outcome, outcome === 'quota' ? nextPeriod('day')
    : outcome === 'qps' ? new Date(Date.now() + 2_000).toISOString() : null);
};

const classifyGoogle = (body) => {
  if (body && typeof body === 'object' && !Array.isArray(body)
    && (body.results === undefined || Array.isArray(body.results))) return null;
  return providerFailure('invalid');
};

export const operationDefinitions = {
  'amap.place-search': {
    provider: 'amap',
    validate: chinaPlace,
    request(parameters, secret) {
      const url = new URL('https://restapi.amap.com/v3/place/text');
      Object.entries({
        key: secret, city: parameters.region, types: '120302', citylimit: 'true', offset: '25',
        page: String(parameters.page), extensions: 'all'
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      if (parameters.subdivision) url.searchParams.set('keywords', parameters.subdivision);
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    },
    classify: classifyAmap
  },
  'baidu.place-search': {
    provider: 'baidu',
    validate: chinaPlace,
    request(parameters, secret) {
      const url = new URL('https://api.map.baidu.com/place/v2/search');
      Object.entries({
        ak: secret, query: `${parameters.subdivision}住宅小区`, region: parameters.region, scope: '2',
        page_size: '20', page_num: String(Math.max(0, parameters.page - 1)), output: 'json'
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    },
    classify: classifyBaidu
  },
  'tencent.place-search': {
    provider: 'tencent',
    validate: chinaPlace,
    request(parameters, secret) {
      const url = new URL('https://apis.map.qq.com/ws/place/v1/search');
      Object.entries({
        key: secret, keyword: `${parameters.subdivision}住宅小区`, boundary: `region(${parameters.region},0)`,
        page_size: '20', page_index: String(parameters.page)
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    },
    classify: classifyTencent
  },
  'onemap.search': {
    provider: 'onemap',
    validate: onemapSearch,
    request(parameters, secret) {
      const url = new URL('https://www.onemap.gov.sg/api/common/elastic/search');
      Object.entries({ searchVal: parameters.searchVal, returnGeom: 'Y', getAddrDetails: 'Y', pageNum: '1' })
        .forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${secret}`, 'User-Agent': 'address-credential-broker/1.0' }
      });
    }
  },
  'geoapify.reverse': {
    provider: 'geoapify',
    validate: geoapifyReverse,
    request(parameters, secret) {
      const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
      Object.entries({
        lat: String(parameters.latitude), lon: String(parameters.longitude), format: 'json',
        lang: parameters.language, apiKey: secret
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    }
  },
  'google-geocoding.reverse': {
    provider: 'google-geocoding',
    validate: googleReverse,
    request(parameters, secret) {
      const url = new URL('https://geocode.googleapis.com/v4/geocode/location');
      url.searchParams.set('location.latitude', String(parameters.latitude));
      url.searchParams.set('location.longitude', String(parameters.longitude));
      url.searchParams.set('languageCode', parameters.language);
      if (parameters.regionCode) url.searchParams.set('regionCode', parameters.regionCode);
      return new Request(url, { headers: {
        Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0',
        'X-Goog-Api-Key': secret,
        'X-Goog-FieldMask': 'results.placeId,results.types,results.addressComponents,results.postalAddress,results.location,results.granularity'
      } });
    },
    classify: classifyGoogle
  },
  'mappls.nearby': {
    provider: 'mappls',
    validate: mapplsNearby,
    request(parameters, secret) {
      const url = new URL('https://search.mappls.com/search/places/nearby/json');
      Object.entries({
        keywords: parameters.categoryCode,
        refLocation: `${parameters.latitude},${parameters.longitude}`,
        region: 'IND', radius: String(parameters.radius), page: String(parameters.page),
        filter: `categoryCode:${parameters.categoryCode}`, access_token: secret
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    }
  },
  'mappls.entity': {
    provider: 'mappls',
    validate: mapplsEntity,
    request(parameters, secret) {
      const url = new URL(`https://explore.mappls.com/apis/O2O/entity/${encodeURIComponent(parameters.eLoc)}`);
      url.searchParams.set('access_token', secret);
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    }
  }
};

const retryAtFrom = (response) => {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(Date.now() + seconds * 1000).toISOString();
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
};

const jsonBody = async (response) => {
  if (!response.body) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > RESPONSE_LIMIT_BYTES) throw Object.assign(new Error('UPSTREAM_RESPONSE_TOO_LARGE'), {
      code: 'UPSTREAM_RESPONSE_TOO_LARGE'
    });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const redact = (value, secret) => {
  const encoded = encodeURIComponent(secret);
  const source = JSON.stringify(value);
  return JSON.parse(source.split(secret).join('[REDACTED]').split(encoded).join('[REDACTED]'));
};

export const executeOperation = async ({ definition, parameters, secret, fetchImpl = fetch, signal }) => {
  let response;
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    response = await fetchImpl(definition.request(parameters, secret), {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
  } catch {
    return { type: 'retry', outcome: 'network', retryAt: null };
  }
  if (response.status === 401 || response.status === 403) {
    return { type: 'retry', outcome: 'auth', retryAt: null };
  }
  if (response.status === 429) {
    const retryAt = retryAtFrom(response);
    const quota = definition.provider === 'mappls'
      || retryAt && Date.parse(retryAt) - Date.now() > 5 * 60_000;
    return { type: 'retry', outcome: quota ? 'quota' : 'qps', retryAt };
  }
  if (response.status >= 500) return { type: 'retry', outcome: 'network', retryAt: retryAtFrom(response) };
  if (!response.ok) return { type: 'error', outcome: 'request', status: 502, code: 'UPSTREAM_REQUEST_REJECTED' };
  try {
    const data = await jsonBody(response);
    const classified = definition.classify?.(data, response);
    if (classified) return classified;
    return { type: 'success', status: 200, data: redact(data, secret) };
  } catch (error) {
    return {
      type: error?.code === 'UPSTREAM_RESPONSE_TOO_LARGE' ? 'error' : 'retry',
      outcome: error?.code === 'UPSTREAM_RESPONSE_TOO_LARGE' ? 'request' : 'network',
      status: 502,
      code: error?.code || 'UPSTREAM_INVALID_JSON',
      retryAt: null
    };
  }
};
