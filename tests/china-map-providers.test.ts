import { describe, expect, it } from 'vitest';
import { bd09ToWgs84, gcj02ToWgs84, wgs84ToGcj02 } from '../server/china/coordinates';
import { fetchAmapCommunities, fetchBaiduCommunities, fetchTencentCommunities } from '../server/china/providers';

const response = (value: unknown) => async () => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

describe('China map community providers', () => {
  it('normalizes Amap, Tencent and Baidu responses without retaining keys', async () => {
    const amap = await fetchAmapCommunities('北京市', 1, 'secret', response({ status: '1', pois: [{
      id: 'a-1', name: '望京花园', address: '阜通东大街6号', location: '116.470000,39.995000', pname: '北京市', cityname: '北京市', adname: '朝阳区', typecode: '120302', adcode: '110105'
    }] }));
    const tencent = await fetchTencentCommunities('北京市', 1, 'secret', response({ status: 0, data: [{
      id: 't-1', title: '望京花园', address: '阜通东大街6号', location: { lat: 39.995, lng: 116.47 }, ad_info: { province: '北京市', city: '北京市', district: '朝阳区' }
    }] }));
    const baidu = await fetchBaiduCommunities('北京市', 1, 'secret', response({ status: 0, results: [{
      uid: 'b-1', name: '望京花园', address: '阜通东大街6号', location: { lat: 40.001, lng: 116.4765 }, province: '北京市', city: '北京市', area: '朝阳区'
    }] }));
    expect(amap.candidates[0]).toMatchObject({ provider: 'amap', providerPoiId: 'a-1', district: '朝阳区', rawCrs: 'GCJ-02' });
    expect(tencent.candidates[0]).toMatchObject({ provider: 'tencent', providerPoiId: 't-1', rawCrs: 'GCJ-02' });
    expect(baidu.candidates[0]).toMatchObject({ provider: 'baidu', providerPoiId: 'b-1', rawCrs: 'BD-09' });
    expect([amap.rawCount, tencent.rawCount, baidu.rawCount]).toEqual([1, 1, 1]);
    expect(JSON.stringify([amap, tencent, baidu])).not.toContain('secret');
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
    expect(quota).toEqual({ used: 17, limit: 200 });
  });

  it('classifies provider quota errors for key rotation', async () => {
    await expect(fetchAmapCommunities('北京市', 1, 'secret', response({ status: '0', infocode: '10003', info: 'quota' })))
      .rejects.toMatchObject({ outcome: 'quota' });
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
