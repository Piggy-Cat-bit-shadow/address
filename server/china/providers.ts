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

export class ProviderRequestError extends Error {
  constructor(public readonly outcome: 'qps' | 'quota' | 'auth' | 'network' | 'invalid', message: string) { super(message); }
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
type QuotaObserver = (observation: ProviderQuotaObservation) => void;
const requestJson = async (url: URL, fetcher: typeof fetch): Promise<{ body: unknown; headers: Headers }> => {
  let response: Response;
  try { response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); }
  catch (error) { throw new ProviderRequestError('network', requestErrorMessage(error, url)); }
  if (response.status === 429) throw new ProviderRequestError('qps', 'RATE_LIMITED');
  if (!response.ok) throw new ProviderRequestError(response.status === 401 || response.status === 403 ? 'auth' : 'network', `HTTP_${response.status}`);
  try { return { body: await response.json(), headers: response.headers }; } catch { throw new ProviderRequestError('invalid', 'INVALID_JSON'); }
};

export const fetchAmapCommunities = async (region: string, page: number, key: string, fetcher: typeof fetch = fetch, _observeQuota?: QuotaObserver): Promise<ProviderPage> => {
  const url = new URL('https://restapi.amap.com/v5/place/text');
  Object.entries({ key, region, types: '120302', city_limit: 'true', page_size: '25', page_num: String(page), show_fields: 'business' })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  const { body } = await requestJson(url, fetcher) as { body: { status?: string; infocode?: string; info?: string; pois?: Array<Record<string, unknown>> }; headers: Headers };
  if (body.status !== '1') {
    const outcome = body.infocode === '10003' ? 'quota' : body.infocode === '10004' ? 'qps'
      : ['10001', '10002', '10007', '10009', '10012', '10013'].includes(body.infocode || '') ? 'auth' : 'invalid';
    throw new ProviderRequestError(outcome, redactSecrets(body.info || body.infocode, [key]));
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

export const fetchTencentCommunities = async (city: string, page: number, key: string, fetcher: typeof fetch = fetch, observeQuota?: QuotaObserver): Promise<ProviderPage> => {
  const url = new URL('https://apis.map.qq.com/ws/place/v1/search');
  Object.entries({ key, keyword: '住宅小区', boundary: `region(${city},0)`, page_size: '20', page_index: String(page) })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  const response = await requestJson(url, fetcher);
  const body = response.body as { status?: number; message?: string; data?: Array<Record<string, unknown>> };
  const limits = Object.fromEntries([...String(response.headers.get('x-limit') || '').matchAll(/([a-z_]+)=(\d+)/giu)]
    .map((match) => [match[1].toLowerCase(), Number(match[2])]));
  if (Number.isSafeInteger(limits.current_pv) && Number.isSafeInteger(limits.limit_pv) && limits.limit_pv > 0) {
    observeQuota?.({ used: limits.current_pv, limit: limits.limit_pv });
  }
  if (body.status !== 0) {
    const outcome = body.status === 120 ? 'qps' : body.status === 121 ? 'quota' : [110, 111, 112].includes(Number(body.status)) ? 'auth' : 'invalid';
    throw new ProviderRequestError(outcome, redactSecrets(body.message || body.status, [key]));
  }
  const data = body.data || [];
  const candidates = data.map((item) => {
    const location = item.location as Record<string, unknown> | undefined;
    const admin = item.ad_info as Record<string, unknown> | undefined;
    const rawLatitude = finite(location?.lat); const rawLongitude = finite(location?.lng);
    if (rawLatitude === null || rawLongitude === null) return null;
    const [latitude, longitude] = gcj02ToWgs84(rawLatitude, rawLongitude);
    return {
      provider: 'tencent' as const, providerPoiId: clean(item.id), name: clean(item.title), address: clean(item.address),
      province: clean(admin?.province), city: clean(admin?.city), district: clean(admin?.district), township: '',
      latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'GCJ-02' as const, responseHash: hash(item),
      typecode: clean(item.category), adcode: clean(admin?.adcode)
    };
  }).filter(presentCandidate);
  return { candidates, rawCount: data.length };
};

export const fetchBaiduCommunities = async (city: string, page: number, key: string, fetcher: typeof fetch = fetch, _observeQuota?: QuotaObserver): Promise<ProviderPage> => {
  const url = new URL('https://api.map.baidu.com/place/v2/search');
  Object.entries({ ak: key, query: '住宅小区', region: city, scope: '2', page_size: '20', page_num: String(Math.max(0, page - 1)), output: 'json' })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  const { body } = await requestJson(url, fetcher) as { body: { status?: number; message?: string; results?: Array<Record<string, unknown>> }; headers: Headers };
  if (body.status !== 0) {
    const outcome = body.status === 302 ? 'quota' : body.status === 301 ? 'qps' : [101, 102, 200, 201].includes(Number(body.status)) ? 'auth' : 'invalid';
    throw new ProviderRequestError(outcome, redactSecrets(body.message || body.status, [key]));
  }
  const results = body.results || [];
  const candidates = results.map((item) => {
    const location = item.location as Record<string, unknown> | undefined;
    const detail = item.detail_info as Record<string, unknown> | undefined;
    const rawLatitude = finite(location?.lat); const rawLongitude = finite(location?.lng);
    if (rawLatitude === null || rawLongitude === null) return null;
    const [latitude, longitude] = bd09ToWgs84(rawLatitude, rawLongitude);
    return {
      provider: 'baidu' as const, providerPoiId: clean(item.uid), name: clean(item.name), address: clean(item.address),
      province: clean(item.province), city: clean(item.city), district: clean(item.area), township: clean(detail?.tag),
      latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'BD-09' as const, responseHash: hash(item),
      typecode: clean(detail?.tag), adcode: clean(item.adcode)
    };
  }).filter(presentCandidate);
  return { candidates, rawCount: results.length };
};

export const providerFetcher = {
  amap: fetchAmapCommunities,
  baidu: fetchBaiduCommunities,
  tencent: fetchTencentCommunities
};
