import { describe, expect, it } from 'vitest';
import { bd09ToWgs84, gcj02ToWgs84, wgs84ToGcj02 } from '../server/china/coordinates';
import {
  fetchAmapCommunities, fetchBaiduCommunities, fetchBrokerCommunities, fetchTencentCommunities
} from '../server/china/providers';

const response = (value: unknown) => async () => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

describe('China map community providers', () => {
  it('normalizes Amap, Tencent and Baidu responses without retaining keys', async () => {
    const amap = await fetchAmapCommunities('北京市', 1, 'secret', response({ status: '1', pois: [{
      id: 'a-1', name: '望京花园', address: '阜通东大街6号', location: '116.470000,39.995000', pname: '北京市', cityname: '北京市', adname: '朝阳区', typecode: '120302', adcode: '110105'
    }] }));
    const tencent = await fetchTencentCommunities('北京市', 1, 'secret', response({ status: 0, data: [{
      id: 't-1', title: '望京花园', address: '阜通东大街6号', category: '房产小区:住宅区', location: { lat: 39.995, lng: 116.47 }, ad_info: { province: '北京市', city: '北京市', district: '朝阳区' }
    }] }));
    const baidu = await fetchBaiduCommunities('北京市', 1, 'secret', response({ status: 0, results: [{
      uid: 'b-1', name: '望京花园', address: '阜通东大街6号', location: { lat: 40.001, lng: 116.4765 }, province: '北京市', city: '北京市', area: '朝阳区', detail_info: { tag: '房地产;住宅区' }
    }] }));
    expect(amap.candidates[0]).toMatchObject({ provider: 'amap', providerPoiId: 'a-1', district: '朝阳区', rawCrs: 'GCJ-02' });
    expect(tencent.candidates[0]).toMatchObject({ provider: 'tencent', providerPoiId: 't-1', rawCrs: 'GCJ-02' });
    expect(baidu.candidates[0]).toMatchObject({ provider: 'baidu', providerPoiId: 'b-1', rawCrs: 'BD-09' });
    expect([amap.rawCount, tencent.rawCount, baidu.rawCount]).toEqual([1, 1, 1]);
    expect(JSON.stringify([amap, tencent, baidu])).not.toContain('secret');
  });

  it('parses China communities returned through the broker without receiving a provider key', async () => {
    const requests: unknown[][] = [];
    const broker = {
      request: async (...args: unknown[]) => {
        requests.push(args);
        return { status: '1', pois: [{
          id: 'broker-a-1', name: '望京花园', address: '阜通东大街6号', location: '116.470000,39.995000',
          pname: '北京市', cityname: '北京市', adname: '朝阳区', typecode: '120302', adcode: '110105'
        }] };
      },
      availability: async () => ({})
    };
    const page = await fetchBrokerCommunities('amap', '110105', 2, broker, '望京街道');
    expect(requests).toEqual([['amap.place-search', {
      region: '110105', page: 2, subdivision: '望京街道'
    }]]);
    expect(page).toMatchObject({
      rawCount: 1, candidates: [expect.objectContaining({ provider: 'amap', providerPoiId: 'broker-a-1' })]
    });
    expect(JSON.stringify(requests)).not.toMatch(/key|secret/iu);
  });

  it('uses exact Amap residential type and district boundaries', async () => {
    let requested = '';
    const values = await fetchAmapCommunities('110105', 1, 'secret', async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ status: '1', pois: [
        { id: 'exact', name: '望京花园', address: '阜通东大街6号', location: '116.47,39.995', pname: '北京市', cityname: '北京市', adname: '朝阳区', typecode: '120302', adcode: '110105' },
        { id: 'wrong-type', name: '商场', address: '阜通东大街8号', location: '116.47,39.995', pname: '北京市', cityname: '北京市', adname: '朝阳区', typecode: '060100', adcode: '110105' },
        { id: 'wrong-district', name: '其他小区', address: '东城路1号', location: '116.41,39.91', pname: '北京市', cityname: '北京市', adname: '东城区', typecode: '120302', adcode: '110101' }
      ] }), { headers: { 'content-type': 'application/json' } });
    });
    expect(values.candidates.map((value) => value.providerPoiId)).toEqual(['exact']);
    expect(values.rawCount).toBe(3);
    expect(requested).toContain('types=120302');
    expect(requested).toContain('city_limit=true');
    expect(requested).toContain('region=110105');
    expect(requested).not.toContain('keywords=');
  });

  it('adds the township keyword to subdivided provider queries', async () => {
    const urls: string[] = [];
    const record = (payload: unknown) => async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await fetchAmapCommunities('110101', 1, 'secret', record({ status: '1', pois: [] }), undefined, '东华门街道');
    await fetchTencentCommunities('北京市东城区', 1, 'secret', record({ status: 0, data: [] }), undefined, '东华门街道');
    await fetchBaiduCommunities('北京市东城区', 1, 'secret', record({ status: 0, results: [] }), undefined, '东华门街道');
    expect(urls[0]).toContain(`keywords=${encodeURIComponent('东华门街道')}`);
    expect(urls[0]).toContain('region=110101');
    expect(urls[1]).toContain(`keyword=${encodeURIComponent('东华门街道住宅小区')}`);
    expect(urls[2]).toContain(`query=${encodeURIComponent('东华门街道住宅小区')}`);
  });

  it('keeps numbered delivery addresses, trims navigation suffixes, and rejects map directions', async () => {
    const values = await fetchAmapCommunities('110105', 1, 'secret', response({ status: '1', pois: [
      { id: 'clean', name: '望京花园', address: '阜通东大街6号(望京地铁站C口步行410米)', location: '116.47,39.995', pname: '北京市', cityname: '北京市', adname: '朝阳区', typecode: '120302', adcode: '110105' },
      { id: 'intersection', name: '方向小区', address: '阜通东大街与望京街交叉口东40米', location: '116.47,39.995', pname: '北京市', cityname: '北京市', adname: '朝阳区', typecode: '120302', adcode: '110105' },
      { id: 'town-only', name: '村镇小区', address: '望京镇', location: '116.47,39.995', pname: '北京市', cityname: '北京市', adname: '朝阳区', typecode: '120302', adcode: '110105' }
    ] }));
    expect(values.candidates).toHaveLength(1);
    expect(values.candidates[0]).toMatchObject({ providerPoiId: 'clean', address: '阜通东大街6号' });
  });

  it('reports Tencent provider quota headers', async () => {
    let quota;
    await fetchTencentCommunities('北京市', 1, 'secret', async () => new Response(JSON.stringify({ status: 0, data: [] }), {
      headers: { 'content-type': 'application/json', 'X-Limit': 'current_qps=1; limit_qps=5; current_pv=17; limit_pv=200' }
    }), (value) => { quota = value; });
    expect(quota).toMatchObject({ used: 17, limit: 200, period: 'day' });
    expect(Date.parse(quota!.resetAt!)).toBeGreaterThan(Date.now());
  });

  it('classifies provider quota errors for key rotation', async () => {
    const amap = fetchAmapCommunities('北京市', 1, 'secret', response({ status: '0', infocode: '10003', info: 'quota' }));
    await expect(amap).rejects.toMatchObject({ outcome: 'quota', providerCode: '10003' });
    await expect(amap).rejects.toHaveProperty('retryAt');
    await expect(fetchAmapCommunities('北京市', 1, 'secret', response({ status: '0', infocode: '40000', info: 'plan quota' })))
      .rejects.toMatchObject({ outcome: 'quota', providerCode: '40000', quotaPeriod: 'month' });
    await expect(fetchBaiduCommunities('北京市', 1, 'secret', response({ status: 4, message: 'quota' })))
      .rejects.toMatchObject({ outcome: 'quota' });
    await expect(fetchTencentCommunities('北京市', 1, 'secret', response({ status: 121, message: 'quota' })))
      .rejects.toMatchObject({ outcome: 'quota' });
  });

  it('classifies Amap QPS and credential errors from the official WebService table', async () => {
    const qps = fetchAmapCommunities('北京市', 1, 'secret', response({ status: '0', infocode: '10020', info: 'qps' }));
    await expect(qps).rejects.toMatchObject({ outcome: 'qps', providerCode: '10020' });
    await expect(qps).rejects.toHaveProperty('retryAt');
    await expect(fetchAmapCommunities('北京市', 1, 'secret', response({ status: '0', infocode: '10041', info: 'expired service' })))
      .rejects.toMatchObject({ outcome: 'auth' });
  });

  it('uses Retry-After for HTTP rate limits', async () => {
    const startedAt = Date.now();
    let failure: unknown;
    try {
      await fetchAmapCommunities('北京市', 1, 'secret', async () => new Response('{}', {
        status: 429, headers: { 'Retry-After': '7' }
      }));
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ outcome: 'qps', providerCode: 'HTTP_429' });
    const retryAt = Date.parse(String((failure as { retryAt?: string }).retryAt));
    expect(retryAt).toBeGreaterThanOrEqual(startedAt + 6_900);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 7_100);
  });

  it('rejects non-residential or non-deliverable Baidu and Tencent results', async () => {
    const tencent = await fetchTencentCommunities('北京市', 1, 'secret', response({ status: 0, data: [{
      id: 'shop', title: '望京商场', address: '阜通东大街6号', category: '购物:商场',
      location: { lat: 39.995, lng: 116.47 }, ad_info: { province: '北京市', city: '北京市', district: '朝阳区' }
    }] }));
    const baidu = await fetchBaiduCommunities('北京市', 1, 'secret', response({ status: 0, results: [{
      uid: 'road-only', name: '望京花园', address: '阜通东大街', location: { lat: 40.001, lng: 116.4765 },
      province: '北京市', city: '北京市', area: '朝阳区', detail_info: { tag: '房地产;住宅区' }
    }] }));
    expect(tencent.candidates).toEqual([]);
    expect(baidu.candidates).toEqual([]);
  });

  it('redacts raw and URL-encoded provider keys from network errors', async () => {
    const key = 'secret/key value';
    const encoded = new URLSearchParams({ key }).toString().slice('key='.length);
    let failure: unknown;
    try {
      await fetchAmapCommunities('北京市', 1, key, async (input) => {
        throw new Error(`network request failed: ${String(input)}`);
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ outcome: 'network' });
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).not.toContain(key);
    expect(message).not.toContain(encoded);
    expect(message).toContain('REDACTED');
  });

  it('treats a non-JSON upstream page as a temporary network failure', async () => {
    await expect(fetchAmapCommunities('110105', 1, 'secret', async () => new Response('<html>blocked</html>', { status: 200 })))
      .rejects.toMatchObject({ outcome: 'network', message: 'INVALID_JSON' });
  });

  it('falls back from an Amap v5 HTML response to v3 with the same key', async () => {
    const urls: URL[] = [];
    const result = await fetchAmapCommunities('110105', 2, 'same-secret', async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.startsWith('/v5/')) return new Response('<html>blocked</html>', { status: 200 });
      return Response.json({ status: '1', pois: [{
        id: 'fallback-poi', name: '回退花园', address: '文化路18号', location: '116.47,39.995',
        pname: '北京市', cityname: '北京市', adname: '朝阳区', typecode: '120302', adcode: '110105'
      }] });
    });
    expect(urls.map((url) => url.pathname)).toEqual(['/v5/place/text', '/v3/place/text']);
    expect(urls.every((url) => url.searchParams.get('key') === 'same-secret')).toBe(true);
    expect(urls[1].searchParams.get('city')).toBe('110105');
    expect(urls[1].searchParams.get('citylimit')).toBe('true');
    expect(urls[1].searchParams.get('page')).toBe('2');
    expect(result.candidates).toEqual([expect.objectContaining({ providerPoiId: 'fallback-poi' })]);
  });

  it('converts provider coordinates into the common WGS-84 system', () => {
    const source: [number, number] = [39.9042, 116.4074];
    const gcj = wgs84ToGcj02(...source);
    const restored = gcj02ToWgs84(...gcj);
    expect(Math.abs(restored[0] - source[0])).toBeLessThan(0.0001);
    expect(Math.abs(restored[1] - source[1])).toBeLessThan(0.0001);
    const baidu = bd09ToWgs84(gcj[0] + 0.006, gcj[1] + 0.0065);
    expect(Math.abs(baidu[0] - source[0])).toBeLessThan(0.001);
    expect(Math.abs(baidu[1] - source[1])).toBeLessThan(0.001);
  });
});
