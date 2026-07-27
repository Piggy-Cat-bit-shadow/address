import { createHash } from 'node:crypto';
import { bd09ToWgs84, gcj02ToWgs84 } from './coordinates';
import type { ProviderName } from '../control/store';

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
}

export class ProviderRequestError extends Error {
  constructor(public readonly outcome: 'qps' | 'quota' | 'auth' | 'network' | 'invalid', message: string) { super(message); }
}

const clean = (value: unknown): string => String(value ?? '').replace(/\s+/gu, ' ').trim();
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = (value: unknown): number | null => Number.isFinite(Number(value)) ? Number(value) : null;
const presentCandidate = <T extends CommunityCandidate>(value: T | null): value is T => Boolean(value?.providerPoiId && value.name);
const requestJson = async (url: URL, fetcher: typeof fetch): Promise<unknown> => {
  let response: Response;
  try { response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); }
  catch (error) { throw new ProviderRequestError('network', error instanceof Error ? error.message : String(error)); }
  if (response.status === 429) throw new ProviderRequestError('qps', 'RATE_LIMITED');
  if (!response.ok) throw new ProviderRequestError(response.status === 401 || response.status === 403 ? 'auth' : 'network', `HTTP_${response.status}`);
  try { return await response.json(); } catch { throw new ProviderRequestError('invalid', 'INVALID_JSON'); }
};

export const fetchAmapCommunities = async (city: string, page: number, key: string, fetcher: typeof fetch = fetch): Promise<CommunityCandidate[]> => {
  const url = new URL('https://restapi.amap.com/v5/place/text');
  Object.entries({ key, keywords: '住宅小区', region: city, types: '120000', page_size: '25', page_num: String(page), show_fields: 'business' })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  const body = await requestJson(url, fetcher) as { status?: string; infocode?: string; info?: string; pois?: Array<Record<string, unknown>> };
  if (body.status !== '1') {
    const outcome = body.infocode === '10003' ? 'quota' : /^1000[1-9]$/u.test(body.infocode || '') ? 'auth' : 'invalid';
    throw new ProviderRequestError(outcome, clean(body.info || body.infocode));
  }
  return (body.pois || []).map((item) => {
    const [rawLongitude, rawLatitude] = clean(item.location).split(',').map(Number);
    if (!Number.isFinite(rawLatitude) || !Number.isFinite(rawLongitude)) return null;
    const [latitude, longitude] = gcj02ToWgs84(rawLatitude, rawLongitude);
    return {
      provider: 'amap' as const, providerPoiId: clean(item.id), name: clean(item.name), address: clean(item.address),
      province: clean(item.pname), city: clean(item.cityname), district: clean(item.adname), township: '',
      latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'GCJ-02' as const, responseHash: hash(item)
    };
  }).filter(presentCandidate);
};

export const fetchTencentCommunities = async (city: string, page: number, key: string, fetcher: typeof fetch = fetch): Promise<CommunityCandidate[]> => {
  const url = new URL('https://apis.map.qq.com/ws/place/v1/search');
  Object.entries({ key, keyword: '住宅小区', boundary: `region(${city},0)`, page_size: '20', page_index: String(page) })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  const body = await requestJson(url, fetcher) as { status?: number; message?: string; data?: Array<Record<string, unknown>> };
  if (body.status !== 0) {
    const outcome = body.status === 120 ? 'quota' : body.status === 121 ? 'qps' : [110, 111, 112].includes(Number(body.status)) ? 'auth' : 'invalid';
    throw new ProviderRequestError(outcome, clean(body.message || body.status));
  }
  return (body.data || []).map((item) => {
    const location = item.location as Record<string, unknown> | undefined;
    const admin = item.ad_info as Record<string, unknown> | undefined;
    const rawLatitude = finite(location?.lat); const rawLongitude = finite(location?.lng);
    if (rawLatitude === null || rawLongitude === null) return null;
    const [latitude, longitude] = gcj02ToWgs84(rawLatitude, rawLongitude);
    return {
      provider: 'tencent' as const, providerPoiId: clean(item.id), name: clean(item.title), address: clean(item.address),
      province: clean(admin?.province), city: clean(admin?.city), district: clean(admin?.district), township: '',
      latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'GCJ-02' as const, responseHash: hash(item)
    };
  }).filter(presentCandidate);
};

export const fetchBaiduCommunities = async (city: string, page: number, key: string, fetcher: typeof fetch = fetch): Promise<CommunityCandidate[]> => {
  const url = new URL('https://api.map.baidu.com/place/v2/search');
  Object.entries({ ak: key, query: '住宅小区', region: city, scope: '2', page_size: '20', page_num: String(Math.max(0, page - 1)), output: 'json' })
    .forEach(([name, value]) => url.searchParams.set(name, value));
  const body = await requestJson(url, fetcher) as { status?: number; message?: string; results?: Array<Record<string, unknown>> };
  if (body.status !== 0) {
    const outcome = body.status === 302 ? 'quota' : body.status === 301 ? 'qps' : [101, 102, 200, 201].includes(Number(body.status)) ? 'auth' : 'invalid';
    throw new ProviderRequestError(outcome, clean(body.message || body.status));
  }
  return (body.results || []).map((item) => {
    const location = item.location as Record<string, unknown> | undefined;
    const detail = item.detail_info as Record<string, unknown> | undefined;
    const rawLatitude = finite(location?.lat); const rawLongitude = finite(location?.lng);
    if (rawLatitude === null || rawLongitude === null) return null;
    const [latitude, longitude] = bd09ToWgs84(rawLatitude, rawLongitude);
    return {
      provider: 'baidu' as const, providerPoiId: clean(item.uid), name: clean(item.name), address: clean(item.address),
      province: clean(item.province), city: clean(item.city), district: clean(item.area), township: clean(detail?.tag),
      latitude, longitude, rawLatitude, rawLongitude, rawCrs: 'BD-09' as const, responseHash: hash(item)
    };
  }).filter(presentCandidate);
};

export const providerFetcher = {
  amap: fetchAmapCommunities,
  baidu: fetchBaiduCommunities,
  tencent: fetchTencentCommunities
};
