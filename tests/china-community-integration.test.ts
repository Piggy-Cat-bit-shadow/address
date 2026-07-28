import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChinaDataService } from '../server/china/service';
import { ControlStore } from '../server/control/store';
import { initializeSqliteDatabase, openDatabase, type SqliteDatabase } from '../server/database/sqlite.mjs';
import { countChinaCommunities, pickChinaCommunityAddress } from '../server/api/repositories/china-community';
import type { CommunityCandidate } from '../server/china/providers';

const candidate = (provider: CommunityCandidate['provider'], providerPoiId: string, address: string): CommunityCandidate => ({
  provider,
  providerPoiId,
  name: '光明小区',
  address,
  province: '河北省',
  city: '唐山市',
  district: '丰润区',
  township: '丰润镇',
  latitude: 39.832,
  longitude: 118.162,
  rawLatitude: 39.838,
  rawLongitude: 118.168,
  rawCrs: provider === 'baidu' ? 'BD-09' : 'GCJ-02',
  responseHash: `${provider}-${providerPoiId}`,
  typecode: provider === 'amap' ? '120302' : '住宅小区',
  adcode: '110105'
});

const upsertCandidate = (service: ChinaDataService, value: CommunityCandidate): Promise<number> =>
  (service as unknown as { upsertCandidate(candidate: CommunityCandidate): Promise<number> }).upsertCandidate(value);
const targetCount = (service: ChinaDataService): Promise<number> =>
  (service as unknown as { targetCount(target: Record<string, unknown>): Promise<number> }).targetCount({
    id: '130208', province: '河北省', city: '唐山市', district: '丰润区', query: '唐山市丰润区', targetCount: 10
  });

const daysAgo = (days: number): string => new Date(Date.now() - days * 86400000).toISOString();

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

  it('imports AreaCity hierarchy and builds automatic district targets', async () => {
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
    expect(await addressDb.prepare('SELECT query FROM cn_sync_area_targets WHERE adcode=?').bind('110105').first('query'))
      .toBe('北京市朝阳区');
    await expect(service.start()).rejects.toThrow('NO_AVAILABLE_KEY');
  });

  it('reports fallback city coverage before AreaCity data is imported', async () => {
    const service = new ChinaDataService(addressDb, control);
    await service.initializeTargets();
    const status = await service.status() as {
      usingFallback: boolean;
      coverage: { districts_total: number; districts_covered: number; communities_needed: number };
      areas: Array<Record<string, unknown>>;
    };
    expect(status.usingFallback).toBe(true);
    expect(status.coverage.districts_total).toBeGreaterThan(0);
    expect(status.coverage.districts_covered).toBe(0);
    expect(status.coverage.communities_needed).toBe(status.coverage.districts_total * 10);
    expect(status.areas[0]).toMatchObject({ district: '重点城市', target_count: 10, current_count: 0 });
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
    expect(address?.verificationLevel).toBe('L2');
    expect(new Set(address?.evidence.map((item) => item.sourceId))).toEqual(new Set(['amap', 'tencent']));
  });

  it('publishes one strict Amap record without treating duplicate POIs as cross-provider evidence', async () => {
    const now = new Date().toISOString();
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'community-single-provider', '望京花园', '望京', '北京市', '北京市', '朝阳区', '望京街道',
      '阜通东大街6号', 116.463, 39.989, 'L1', 1, now, now, now
    ).run();
    for (const id of ['poi-1', 'poi-2']) {
      await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'amap', id, 'community-single-provider', '望京花园', '阜通东大街6号', 116.47, 39.995,
        'GCJ-02', `hash-${id}`, now, now
      ).run();
    }
    const address = await pickChinaCommunityAddress(addressDb, { city: '北京市' }, 'seed');
    expect(address).toMatchObject({ verificationLevel: 'L1', components: { buildingName: '望京花园' } });
    expect(new Set(address?.evidence.map((item) => item.sourceId))).toEqual(new Set(['amap']));
  });

  it.each([
    ['a conflicting house number', '文化路18号', '文化路88号', 1, 2],
    ['a source without a house number', '文化路18号', '文化路', 0, 1],
    ['a conflicting lane premise', '虹桥路18弄1号', '虹桥路88弄1号', 1, 2]
  ])('does not merge or cross-verify %s', async (_label, firstAddress, secondAddress, secondAccepted, rowCount) => {
    const service = new ChinaDataService(addressDb, control);
    expect(await upsertCandidate(service, candidate('amap', 'amap-18', firstAddress))).toBe(1);
    expect(await upsertCandidate(service, candidate('baidu', 'baidu-other', secondAddress))).toBe(secondAccepted);

    const rows = (await addressDb.prepare(`SELECT provider_address,verification_level,source_count
      FROM cn_communities_v2 ORDER BY provider_address`).all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(rowCount);
    expect(rows.every((row) => row.verification_level === 'L1' && row.source_count === 1)).toBe(true);
    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'conflict')).toMatchObject({
      verificationLevel: 'L1', components: { street: firstAddress }
    });
  });

  it('merges independent providers only when the road and house number agree', async () => {
    const service = new ChinaDataService(addressDb, control);
    await upsertCandidate(service, candidate('amap', 'amap-18', '丰润区文化路18号'));
    expect(await upsertCandidate(service, candidate('baidu', 'baidu-18', '文化路18号院'))).toBe(0);

    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2').first('total')).toBe(1);
    expect(await addressDb.prepare('SELECT verification_level FROM cn_communities_v2').first('verification_level')).toBe('L2');
    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'matching')).toMatchObject({
      components: { street: '丰润区文化路18号', buildingName: '光明小区' }, verificationLevel: 'L2'
    });
  });

  it('moves a changed provider POI away from its former conflicting premise', async () => {
    const service = new ChinaDataService(addressDb, control);
    await upsertCandidate(service, candidate('amap', 'amap-18', '文化路18号'));
    await upsertCandidate(service, candidate('baidu', 'baidu-moving', '文化路18号'));
    expect(await countChinaCommunities(addressDb)).toBe(1);

    await upsertCandidate(service, candidate('baidu', 'baidu-moving', '文化路88号'));
    const rows = (await addressDb.prepare(`SELECT provider_address,verification_level,source_count
      FROM cn_communities_v2 ORDER BY provider_address`).all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.verification_level === 'L1' && row.source_count === 1)).toBe(true);
    expect(await countChinaCommunities(addressDb)).toBe(1);
  });

  it.each([
    ['an expired community', daysAgo(181), daysAgo(1), daysAgo(1), 'L2', 0],
    ['an invalid community date', 'not-a-date', daysAgo(1), daysAgo(1), 'L2', 0],
    ['one expired secondary source', daysAgo(1), daysAgo(1), daysAgo(181), 'L1', 1],
    ['one invalid secondary source date', daysAgo(1), daysAgo(1), 'not-a-date', 'L1', 1]
  ])('applies source freshness correctly for %s', async (_label, communitySeen, firstSeen, secondSeen, expectedLevel, published) => {
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'freshness-community', '光明小区', '光明', '河北省', '唐山市', '丰润区', '丰润镇',
      '文化路18号', 118.162, 39.832, 'L2', 2, daysAgo(300), communitySeen, daysAgo(1)
    ).run();
    for (const [provider, seen] of [['amap', firstSeen], ['baidu', secondSeen]] as const) {
      await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        provider, `${provider}-freshness`, 'freshness-community', '光明小区', '文化路18号', 118.168, 39.838,
        provider === 'baidu' ? 'BD-09' : 'GCJ-02', `${provider}-hash`, daysAgo(300), seen
      ).run();
    }

    const service = new ChinaDataService(addressDb, control);
    await service.initializeTargets();
    expect(await addressDb.prepare('SELECT verification_level FROM cn_communities_v2 WHERE id=?')
      .bind('freshness-community').first('verification_level')).toBe(expectedLevel);
    expect(await countChinaCommunities(addressDb)).toBe(published);
    if (published) expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'stale')).toMatchObject({ verificationLevel: 'L1' });
    else expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'stale')).toBeUndefined();
    expect(await targetCount(service)).toBe(published);
    expect(await service.status()).toMatchObject({ total: published, cross_verified: 0, cities: published });
  });

  it('publishes and counts a community backed by two fresh independent providers', async () => {
    const service = new ChinaDataService(addressDb, control);
    await upsertCandidate(service, candidate('amap', 'amap-fresh', '文化路18号'));
    await upsertCandidate(service, candidate('tencent', 'tencent-fresh', '文化路18号'));
    await service.initializeTargets();

    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'fresh')).toMatchObject({ verificationLevel: 'L2' });
    expect(await targetCount(service)).toBe(1);
    expect(await service.status()).toMatchObject({ total: 1, cross_verified: 1, cities: 1 });
  });

  it('waits through a temporary key pacing interval instead of pausing the sync', async () => {
    const now = new Date().toISOString();
    await addressDb.batch([
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110000', null, 'province', '北京市', '北京市', 'test', now),
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110100', '110000', 'city', '北京市', '北京市/北京市', 'test', now),
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110105', '110100', 'district', '朝阳区', '北京市/北京市/朝阳区', 'test', now)
    ]);
    await control.addCredential({ provider: 'amap', label: 'test', secret: 'test-key', qpsLimit: 5 });
    let requests = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      requests += 1;
      const page = Number(new URL(String(input)).searchParams.get('page_num'));
      return new Response(JSON.stringify({ status: '1', pois: page === 1 ? [{
        id: 'poi-1', name: '望京花园', address: '阜通东大街6号', location: '116.47,39.995',
        pname: '北京市', cityname: '北京市', adname: '朝阳区', adcode: '110105', typecode: '120302'
      }] : [] }), { status: 200 });
    });
    const service = new ChinaDataService(addressDb, control);
    const runId = await service.start();
    let status = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = String((await control.runs(10)).find((run) => run.id === runId)?.status || '');
      if (['succeeded', 'failed', 'paused_quota'].includes(status)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    expect(status).toBe('succeeded');
    expect(requests).toBe(2);
  });
});
