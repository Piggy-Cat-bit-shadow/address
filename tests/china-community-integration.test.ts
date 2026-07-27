import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChinaDataService } from '../server/china/service';
import { ControlStore } from '../server/control/store';
import { initializeSqliteDatabase, openDatabase, type SqliteDatabase } from '../server/database/sqlite.mjs';
import { pickChinaCommunityAddress } from '../server/api/repositories/china-community';

describe('China community storage integration', () => {
  let addressDb: SqliteDatabase;
  let controlDb: SqliteDatabase;
  let control: ControlStore;

  beforeEach(async () => {
    addressDb = openDatabase(':memory:');
    controlDb = openDatabase(':memory:', { migrate: false });
    await initializeSqliteDatabase(controlDb, new URL('../server/control/schema.sql', import.meta.url));
    control = new ControlStore(controlDb, Buffer.alloc(32, 9));
    await control.initialize('correct horse battery staple');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    addressDb.close();
    controlDb.close();
  });

  it('imports AreaCity hierarchy and rejects unsupported providers', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{
      code: '110000', name: '北京市', level: 'province', children: [{
        code: '110100', name: '北京市', level: 'city', children: [{ code: '110105', name: '朝阳区', level: 'district' }]
      }]
    }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new ChinaDataService(addressDb, control);
    expect(await service.importAreaCity('https://example.test/areas.json', 'test-1')).toBe(3);
    expect(await addressDb.prepare('SELECT full_path FROM cn_admin_areas WHERE adcode=?').bind('110105').first('full_path'))
      .toBe('北京市/北京市/朝阳区');
    vi.stubGlobal('fetch', async () => new Response('\uFEFFid,pid,deep,name,ext_name\n11,0,0,北京,北京市\n1101,11,1,北京,北京市\n110105,1101,2,朝阳,朝阳区\n', { status: 200 }));
    expect(await service.importAreaCity('https://example.test/areas.csv', 'test-2')).toBe(3);
    expect(await addressDb.prepare('SELECT full_path FROM cn_admin_areas WHERE adcode=?').bind('110105').first('full_path'))
      .toBe('北京市/北京市/朝阳区');
    await expect(service.start({ cities: ['北京市'], providers: ['invalid' as never] })).rejects.toThrow('INVALID_SYNC_PROVIDERS');
  });

  it('reads generated China addresses only from the map POI community tables', async () => {
    const now = new Date().toISOString();
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'community-1', '望京花园', '望京', '北京市', '北京市', '朝阳区', '望京街道',
      '阜通东大街6号', 116.463, 39.989, 'L2', 2, now, now, now
    ).run();
    await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
      raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'amap', 'poi-1', 'community-1', '望京花园', '阜通东大街6号', 116.47, 39.995, 'GCJ-02', 'hash', now, now
    ).run();
    await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
      raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'tencent', 'poi-2', 'community-1', '望京花园', '阜通东大街6号', 116.47, 39.995, 'GCJ-02', 'hash-2', now, now
    ).run();
    const address = await pickChinaCommunityAddress(addressDb, { region: '北京市', city: '北京市' }, 'seed');
    expect(address).toMatchObject({
      countryCode: 'CN', propertyType: 'apartment', coordinates: { latitude: 39.989, longitude: 116.463 },
      components: { buildingName: '望京花园', district: '朝阳区' }
    });
    expect(address?.nativeAddress).toContain('阜通东大街6号');
    expect(new Set(address?.evidence.map((item) => item.sourceId))).toEqual(new Set(['amap', 'tencent']));
  });
});
