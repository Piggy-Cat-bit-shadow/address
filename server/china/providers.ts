import { createHash } from 'node:crypto';
import { bd09ToWgs84, gcj02ToWgs84 } from './coordinates';
import { isChinaDeliveryAddress, normalizeChinaDeliveryAddress } from './quality';
import type { ProviderName, ProviderQuotaObservation } from '../control/store';

export interface CommunityCandidate {
  provider: ProviderName;
  providerPoiId: string;
  name: string;
  address: string;
  province: string;
  city: string;
  district: string;
  township: string;
  latitude: number;
  longitude: number;
  rawLatitude: number;
  rawLongitude: number;
  rawCrs: 'GCJ-02' | 'BD-09';
  responseHash: string;
  typecode: string;
  adcode: string;
}

export interface ProviderPage {
  candidates: CommunityCandidate[];
  rawCount: number;
}

export interface ChinaCredentialBroker {
  request(operation: string, parameters: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  availability(providers: string[], options?: { signal?: AbortSignal }): Promise<Record<string, {
    known: boolean; available: boolean; nextResetAt: string | null; waitState: string | null; reason: string | null;
  }>>;
}

export class ProviderRequestError extends Error {
  constructor(
    public readonly outcome: 'qps' | 'quota' | 'auth' | 'network' | 'invalid',
    message: string,
    public readonly providerCode = '',
    public readonly retryAt: string | null = null,
    public readonly quotaPeriod?: 'day' | 'month'
  ) { super(message); }
}

interface AmapResponse {
  status?: string;
  infocode?: string;
  info?: string;
  pois?: Array<Record<string, unknown>>;
}

const clean = (value: unknown): string => String(value ?? '').replace(/\s+/gu, ' ').trim();
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = (value: unknown): number | null => Number.isFinite(Number(value)) ? Number(value) : null;
const redactSecrets = (value: unknown, secrets: string[]): string => {
  let message = clean(value);
  for (const secret of secrets.filter(Boolean)) {
    const form = new URLSearchParams([['value', secret]]).toString().slice('value='.length);
    for (const candidate of new Set([secret, encodeURIComponent(secret), encodeURI(secret), form])) {
      if (candidate) message = message.split(candidate).join('[REDACTED]');
    }
  }
  return message.slice(0, 500);
};
const requestErrorMessage = (error: unknown, url: URL): string => {
  const secrets = [...url.searchParams.getAll('key'), ...url.searchParams.getAll('ak')].filter(Boolean);
  const redactedUrl = new URL(url);
  for (const name of ['key', 'ak']) {
    if (redactedUrl.searchParams.has(name)) redactedUrl.searchParams.set(name, '[REDACTED]');
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.split(url.toString()).join(redactedUrl.toString());
  return redactSecrets(message, secrets) || 'NETWORK_ERROR';
};
const presentCandidate = <T extends CommunityCandidate>(value: T | null): value is T => Boolean(
  value?.providerPoiId && value.name && value.address && value.province && value.city && value.district
  && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
);
const residentialCategory = (value: string): boolean => /(?:住宅|小区|公寓|家园|花园|新村|嘉园|名苑|家属院)/u.test(value);
type QuotaObserver = (observation: ProviderQuotaObservation) => void;
const nextChinaDay = (): string => {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 8 * 60 * 60 * 1000).toISOString();
};
const nextChinaMonth = (): string => {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  shifted.setUTCMonth(shifted.getUTCMonth() + 1, 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 8 * 60 * 60 * 1000).toISOString();
};
const requestJson = async (url: URL, fetcher: typeof fetch): Promise<{ body: unknown; headers: Headers }> => {
  let response: Response;
  try { response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); }
  catch (error) { throw new ProviderRequestError('network', requestErrorMessage(error, url)); }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const retryAt = Number.isFinite(retryAfter) && retryAfter > 0
      ? new Date(Date.now() + retryAfter * 1000).toISOString()
      : new Date(Date.now() + 2_000).toISOString();
    throw new ProviderRequestError('qps', 'RATE_LIMITED', 'HTTP_429', retryAt);
  }
  if (!response.ok) throw new ProviderRequestError(response.status === 401 || response.status === 403 ? 'auth' : 'network', `HTTP_${response.status}`);
  try { return { body: await response.json(), headers: response.headers }; } catch { throw new ProviderRequestError('network', 'INVALID_JSON'); }
};

const parseAmapPage = (body: AmapResponse, region: string, key = ''): ProviderPage => {
  if (body.status !== '1') {
    const code = body.infocode || '';
    const outcome = ['10003', '10044', '10045', '40000'].includes(code) ? 'quota'
      : ['10004', '10014', '10015', '10019', '10020', '10021', '10029'].includes(code) ? 'qps'
        : ['10001', '10002', '10005', '10006', '10007', '10008', '10009', '10010', '10011', '10012', '10013', '10026', '10041'].includes(code) ? 'auth'
          : 'invalid';
    const quotaPeriod = code === '40000' ? 'month' : 'day';
    const retryAt = ['10003', '10044', '10045'].includes(code) ? nextChinaDay()
      : code === '40000' ? nextChinaMonth()
      : code === '10004'
      ? new Date(Math.ceil((Date.now() + 1) / 60_000) * 60_000).toISOString()
      : outcome === 'qps' ? new Date(Date.now() + 2_000).toISOString() : null;
    throw new ProviderRequestError(outcome, redactSecrets(body.info || body.infocode, [key]), code, retryAt,
      outcome === 'quota' ? quotaPeriod : undefined);
  }
  const pois = body.pois || [];
  const candidates = pois.map((item) => {
    const [rawLongitude, rawLatitude] = clean(item.location).split(',').map(Number);
    if (!Number.isFinite(rawLatitude) || !Number.isFinite(rawLongitude)) return null;
    const [latitude, longitude] = gcj02ToWgs84(rawLatitude, rawLongitude);
    const typecode = clean(item.typecode); const adcode = clean(item.adcode);
    if (typecode !== '120302' || (/^\d{6}$/u.test(region) && adcode !== region)) return null;
    const address = normalizeChinaDeliveryAddress(clean(item.address));
    if (!isChinaDeliveryAddress(address)) return null;
    return {
      provider: 'amap' as const, providerPoiId: clean(item.id), name: clean(item.name), address,
      province: clean(item.pname), city: clean(item.cityname), district: clean(item.adname), township: '',
      latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'GCJ-02' as const, responseHash: hash(item), typecode, adcode
    };
  }).filter(presentCandidate);
  return { candidates, rawCount: pois.length };
};

const requestAmapPage = async (url: URL, region: string, key: string, fetcher: typeof fetch): Promise<ProviderPage> => {
  const { body } = await requestJson(url, fetcher) as { body: AmapResponse; headers: Headers };
  return parseAmapPage(body, region, key);
};

export const fetchAmapCommunities = async (region: string, page: number, key: string, fetcher: typeof fetch = fetch, _observeQuota?: QuotaObserver, subdivision = ''): Promise<ProviderPage> => {
  const primary = new URL('https://restapi.amap.com/v5/place/text');
  Object.entries({ key, region, types: '120302', city_limit: 'true', page_size: '25', page_num: String(page), show_fields: 'business' })
    .forEach(([name, value]) => primary.searchParams.set(name, value));
  if (subdivision) primary.searchParams.set('keywords', subdivision);
  try {
    return await requestAmapPage(primary, region, key, fetcher);
  } catch (error) {
    if (!(error instanceof ProviderRequestError) || error.outcome !== 'network' || error.message !== 'INVALID_JSON') throw error;
  }

  const fallback = new URL('https://restapi.amap.com/v3/place/text');
  Object.entries({ key, city: region, types: '120302', citylimit: 'true', offset: '25', page: String(page), extensions: 'all' })
    .forEach(([name, value]) => fallback.searchParams.set(name, value));
  if (subdivision) fallback.searchParams.set('keywords', subdivision);
  return await requestAmapPage(fallback, region, key, fetcher);
};

export const fetchTencentCommunities = async (city: string, page: number, key: string, fetcher: typeof fetch = fetch, observeQuota?: QuotaObserver, subdivision = ''): Promise<ProviderPage> => {
  const url = new URL('https://apis.map.qq.com/ws/place/v1/search');
  Object.entries({ key, keyword: `${subdivision}住宅小区`, boundary: `region(${city},0)`, page_size: '20', page_index: String(page) })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  const response = await requestJson(url, fetcher);
  const body = response.body as { status?: number; message?: string; data?: Array<Record<string, unknown>> };
  const limits = Object.fromEntries([...String(response.headers.get('x-limit') || '').matchAll(/([a-z_]+)=(\d+)/giu)]
    .map((match) => [match[1].toLowerCase(), Number(match[2])]));
  if (Number.isSafeInteger(limits.current_pv) && Number.isSafeInteger(limits.limit_pv) && limits.limit_pv > 0) {
    observeQuota?.({ used: limits.current_pv, limit: limits.limit_pv, period: 'day', resetAt: nextChinaDay() });
  }
  if (body.status !== 0) {
    const outcome = body.status === 120 ? 'qps' : body.status === 121 ? 'quota' : [110, 111, 112].includes(Number(body.status)) ? 'auth' : 'invalid';
    throw new ProviderRequestError(outcome, redactSecrets(body.message || body.status, [key]), String(body.status || ''),
      outcome === 'qps' ? new Date(Date.now() + 2_000).toISOString() : outcome === 'quota' ? nextChinaDay() : null,
      outcome === 'quota' ? 'day' : undefined);
  }
  const data = body.data || [];
  const candidates = data.map((item) => {
    const location = item.location as Record<string, unknown> | undefined;
    const admin = item.ad_info as Record<string, unknown> | undefined;
    const rawLatitude = finite(location?.lat); const rawLongitude = finite(location?.lng);
    if (rawLatitude === null || rawLongitude === null) return null;
    const [latitude, longitude] = gcj02ToWgs84(rawLatitude, rawLongitude);
    const address = normalizeChinaDeliveryAddress(clean(item.address));
    const typecode = clean(item.category);
    if (!residentialCategory(typecode) || !isChinaDeliveryAddress(address)) return null;
    return {
      provider: 'tencent' as const, providerPoiId: clean(item.id), name: clean(item.title),
      province: clean(admin?.province), city: clean(admin?.city), district: clean(admin?.district), township: '',
      latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'GCJ-02' as const, responseHash: hash(item),
      address, typecode, adcode: clean(admin?.adcode)
    };
  }).filter(presentCandidate);
  return { candidates, rawCount: data.length };
};

export const fetchBaiduCommunities = async (city: string, page: number, key: string, fetcher: typeof fetch = fetch, _observeQuota?: QuotaObserver, subdivision = ''): Promise<ProviderPage> => {
  const url = new URL('https://api.map.baidu.com/place/v2/search');
  Object.entries({ ak: key, query: `${subdivision}住宅小区`, region: city, scope: '2', page_size: '20', page_num: String(Math.max(0, page - 1)), output: 'json' })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  const { body } = await requestJson(url, fetcher) as { body: { status?: number; message?: string; results?: Array<Record<string, unknown>> }; headers: Headers };
  if (body.status !== 0) {
    const outcome = [4, 302].includes(Number(body.status)) ? 'quota' : body.status === 301 ? 'qps' : [101, 102, 200, 201].includes(Number(body.status)) ? 'auth' : 'invalid';
    throw new ProviderRequestError(outcome, redactSecrets(body.message || body.status, [key]), String(body.status || ''),
      outcome === 'qps' ? new Date(Date.now() + 2_000).toISOString() : outcome === 'quota' ? nextChinaDay() : null,
      outcome === 'quota' ? 'day' : undefined);
  }
  const results = body.results || [];
  const candidates = results.map((item) => {
    const location = item.location as Record<string, unknown> | undefined;
    const detail = item.detail_info as Record<string, unknown> | undefined;
    const rawLatitude = finite(location?.lat); const rawLongitude = finite(location?.lng);
    if (rawLatitude === null || rawLongitude === null) return null;
    const [latitude, longitude] = bd09ToWgs84(rawLatitude, rawLongitude);
    const address = normalizeChinaDeliveryAddress(clean(item.address));
    const typecode = clean(detail?.tag);
    if (!residentialCategory(typecode) || !isChinaDeliveryAddress(address)) return null;
    return {
      provider: 'baidu' as const, providerPoiId: clean(item.uid), name: clean(item.name),
      province: clean(item.province), city: clean(item.city), district: clean(item.area), township: '',
      latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'BD-09' as const, responseHash: hash(item),
      address, typecode, adcode: clean(item.adcode)
    };
  }).filter(presentCandidate);
  return { candidates, rawCount: results.length };
};

export const fetchBrokerCommunities = async (
  provider: ProviderName,
  region: string,
  page: number,
  broker: ChinaCredentialBroker,
  subdivision = ''
): Promise<ProviderPage> => {
  const body = await broker.request(`${provider}.place-search`, { region, page, subdivision });
  if (provider === 'amap') return parseAmapPage(body as AmapResponse, region);
  if (provider === 'tencent') {
    const data = (body as { data?: Array<Record<string, unknown>> })?.data || [];
    const candidates = data.map((item) => {
      const location = item.location as Record<string, unknown> | undefined;
      const admin = item.ad_info as Record<string, unknown> | undefined;
      const rawLatitude = finite(location?.lat); const rawLongitude = finite(location?.lng);
      if (rawLatitude === null || rawLongitude === null) return null;
      const [latitude, longitude] = gcj02ToWgs84(rawLatitude, rawLongitude);
      const address = normalizeChinaDeliveryAddress(clean(item.address));
      const typecode = clean(item.category);
      if (!residentialCategory(typecode) || !isChinaDeliveryAddress(address)) return null;
      return {
        provider: 'tencent' as const, providerPoiId: clean(item.id), name: clean(item.title),
        province: clean(admin?.province), city: clean(admin?.city), district: clean(admin?.district), township: '',
        latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'GCJ-02' as const, responseHash: hash(item),
        address, typecode, adcode: clean(admin?.adcode)
      };
    }).filter(presentCandidate);
    return { candidates, rawCount: data.length };
  }
  const results = (body as { results?: Array<Record<string, unknown>> })?.results || [];
  const candidates = results.map((item) => {
    const location = item.location as Record<string, unknown> | undefined;
    const detail = item.detail_info as Record<string, unknown> | undefined;
    const rawLatitude = finite(location?.lat); const rawLongitude = finite(location?.lng);
    if (rawLatitude === null || rawLongitude === null) return null;
    const [latitude, longitude] = bd09ToWgs84(rawLatitude, rawLongitude);
    const address = normalizeChinaDeliveryAddress(clean(item.address));
    const typecode = clean(detail?.tag);
    if (!residentialCategory(typecode) || !isChinaDeliveryAddress(address)) return null;
    return {
      provider: 'baidu' as const, providerPoiId: clean(item.uid), name: clean(item.name),
      province: clean(item.province), city: clean(item.city), district: clean(item.area), township: '',
      latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'BD-09' as const, responseHash: hash(item),
      address, typecode, adcode: clean(item.adcode)
    };
  }).filter(presentCandidate);
  return { candidates, rawCount: results.length };
};

export const providerFetcher = {
  amap: fetchAmapCommunities,
  baidu: fetchBaiduCommunities,
  tencent: fetchTencentCommunities
};
