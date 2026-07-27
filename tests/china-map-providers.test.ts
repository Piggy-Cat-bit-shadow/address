import { describe, expect, it } from 'vitest';
import { bd09ToWgs84, gcj02ToWgs84, wgs84ToGcj02 } from '../server/china/coordinates';
import { fetchAmapCommunities, fetchBaiduCommunities, fetchTencentCommunities } from '../server/china/providers';

const response = (value: unknown) => async () => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

describe('China map community providers', () => {
  it('normalizes Amap, Tencent and Baidu responses without retaining keys', async () => {
    const amap = await fetchAmapCommunities('北京市', 1, 'secret', response({ status: '1', pois: [{
      id: 'a-1', name: '望京花园', address: '阜通东大街6号', location: '116.470000,39.995000', pname: '北京市', cityname: '北京市', adname: '朝阳区'
    }] }));
    const tencent = await fetchTencentCommunities('北京市', 1, 'secret', response({ status: 0, data: [{
      id: 't-1', title: '望京花园', address: '阜通东大街6号', location: { lat: 39.995, lng: 116.47 }, ad_info: { province: '北京市', city: '北京市', district: '朝阳区' }
    }] }));
    const baidu = await fetchBaiduCommunities('北京市', 1, 'secret', response({ status: 0, results: [{
      uid: 'b-1', name: '望京花园', address: '阜通东大街6号', location: { lat: 40.001, lng: 116.4765 }, province: '北京市', city: '北京市', area: '朝阳区'
    }] }));
    expect(amap[0]).toMatchObject({ provider: 'amap', providerPoiId: 'a-1', district: '朝阳区', rawCrs: 'GCJ-02' });
    expect(tencent[0]).toMatchObject({ provider: 'tencent', providerPoiId: 't-1', rawCrs: 'GCJ-02' });
    expect(baidu[0]).toMatchObject({ provider: 'baidu', providerPoiId: 'b-1', rawCrs: 'BD-09' });
    expect(JSON.stringify([amap, tencent, baidu])).not.toContain('secret');
  });

  it('classifies provider quota errors for key rotation', async () => {
    await expect(fetchAmapCommunities('北京市', 1, 'secret', response({ status: '0', infocode: '10003', info: 'quota' })))
      .rejects.toMatchObject({ outcome: 'quota' });
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
