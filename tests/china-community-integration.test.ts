import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChinaDataService } from '../server/china/service';
import { ControlStore } from '../server/control/store';
import { initializeTestDatabase, openTestDatabase, type PostgresDatabase } from './helpers/postgres-test-database.mjs';
import { countChinaCommunities, pickChinaCommunityAddress } from '../server/api/repositories/china-community';
import { updateCountryPolicy, upsertNodeTarget } from '../server/sync/address-policy.mjs';
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
const processCandidate = (service: ChinaDataService, value: CommunityCandidate): Promise<number> =>
  (service as unknown as { processCandidate(candidate: CommunityCandidate): Promise<number> }).processCandidate(value);
const targetCount = (service: ChinaDataService): Promise<number> =>
  (service as unknown as { targetCount(target: Record<string, unknown>): Promise<number> }).targetCount({
    id: '130208', province: '河北省', city: '唐山市', district: '丰润区', query: '唐山市丰润区', targetCount: 10
  });

const daysAgo = (days: number): string => new Date(Date.now() - days * 86400000).toISOString();

describe('China community storage integration', () => {
  let addressDb: PostgresDatabase;
  let controlDb: PostgresDatabase;
  let control: ControlStore;

  beforeEach(async () => {
    addressDb = openTestDatabase(':memory:');
    controlDb = openTestDatabase(':memory:', { migrate: false });
    await initializeTestDatabase(controlDb, new URL('../server/control/schema.sql', import.meta.url));
    control = new ControlStore(controlDb, Buffer.alloc(32, 9));
    await control.initialize('correct horse battery staple');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    addressDb.close();
    controlDb.close();
  });

  it('selects unfiltered communities through the full-pool hash index', async () => {
    const statements: string[] = [];
    const community = {
      id: 'community-1', canonical_name: '测试小区', province: '北京市', city: '北京市',
      district: '朝阳区', township: '', provider_address: '测试路1号', latitude: 39.9,
      longitude: 116.4, verification_level: 'L1', source_count: 1,
      last_seen_at: '2026-08-24T00:00:00Z'
    };
    const database = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind() { return statement; },
          async all() {
            return { results: sql.includes('SELECT DISTINCT provider FROM cn_community_sources')
              ? [{ provider: 'amap' }]
              : [community] };
          }
        };
        return statement;
      }
    };

    await expect(pickChinaCommunityAddress(database as never, {}, 'full-pool'))
      .resolves.toMatchObject({ id: 'cn-community-community-1' });
    expect(statements[0]).toContain('hashtextextended');
    expect(statements[0]).not.toContain('source_count DESC');
    expect(statements[0]).not.toContain('LIMIT 500');
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
    };
    expect(status.usingFallback).toBe(true);
    expect(status.coverage.districts_total).toBeGreaterThan(0);
    expect(status.coverage.districts_covered).toBe(0);
    expect(status.coverage.communities_needed).toBe(status.coverage.districts_total * 5);
  });

  it('automatically resumes when the earliest credential cooldown expires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    try {
      const id = await control.addCredential({ provider: 'amap', label: 'resume-key', secret: 'resume-key-secret' });
      await control.reportCredential(id, 'qps', { retryAt: '2026-08-01T00:00:02.000Z' });
      const service = new ChinaDataService(addressDb, control);
      const start = vi.fn(async () => 'run-after-cooldown');
      (service as unknown as { start: typeof start }).start = start;
      await service.wake(0);
      expect(await service.status()).toMatchObject({
        syncState: 'cooldown_wait', nextAttemptAt: '2026-08-01T00:00:02.000Z'
      });
      await vi.advanceTimersByTimeAsync(2_100);
      expect(start).toHaveBeenCalledOnce();
      service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries every available key until a later key succeeds', async () => {
    const keys = ['key-1', 'key-2', 'key-3', 'key-4'];
    for (const key of keys) await control.addCredential({ provider: 'amap', label: key, secret: key, qpsLimit: 100 });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const key = new URL(String(input)).searchParams.get('key') || '';
      calls.push(key);
      return Response.json(key === 'key-4'
        ? { status: '1', pois: [] }
        : { status: '0', infocode: '10020', info: 'QPS_LIMIT' });
    });
    const service = new ChinaDataService(addressDb, control);
    const fetchPage = (service as unknown as {
      fetchPage(provider: 'amap', target: Record<string, unknown>, page: number, accepted: number, requested: () => Promise<void>): Promise<unknown>;
    }).fetchPage.bind(service);
    let requests = 0;
    expect(await fetchPage('amap', {
      id: '110105', province: '北京市', city: '北京市', district: '朝阳区', query: '北京市朝阳区', targetCount: 5
    }, 1, 0, async () => { requests += 1; })).toMatchObject({ rawCount: 0 });
    expect(calls).toEqual(keys);
    expect(requests).toBe(4);
    expect(await control.listCredentials()).toEqual([
      expect.objectContaining({ label: 'key-1', status: 'cooldown' }),
      expect.objectContaining({ label: 'key-2', status: 'cooldown' }),
      expect.objectContaining({ label: 'key-3', status: 'cooldown' }),
      expect.objectContaining({ label: 'key-4', status: 'healthy' })
    ]);
  });

  it('routes worker page requests through the credential broker without a local provider key', async () => {
    const token = 'china-broker-client-token-fixture-0001';
    const calls: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        authorization: request.headers.get('authorization') || '',
        body: await request.json() as Record<string, unknown>
      });
      return Response.json({ data: { status: '1', pois: [] } });
    });
    const service = new ChinaDataService(addressDb, control, undefined, {
      postgresUrl: 'postgresql://fixture', masterKey: Buffer.alloc(32, 8),
      credentialBroker: { url: 'http://credential-broker.internal', token }
    });
    const fetchPage = (service as unknown as {
      fetchPage(provider: 'amap', target: Record<string, unknown>, page: number, accepted: number, requested: () => Promise<void>): Promise<unknown>;
    }).fetchPage.bind(service);
    let requests = 0;
    expect(await fetchPage('amap', {
      id: '110105', province: '北京市', city: '北京市', district: '朝阳区', query: '北京市朝阳区', targetCount: 5
    }, 1, 0, async () => { requests += 1; })).toMatchObject({ rawCount: 0 });
    expect(requests).toBe(1);
    expect(calls).toEqual([expect.objectContaining({
      url: 'http://credential-broker.internal/v1/requests',
      authorization: `Bearer ${token}`,
      body: expect.objectContaining({
        operation: 'amap.place-search', parameters: { region: '110105', page: 1, subdivision: '' }
      })
    })]);
    expect(await control.listCredentials()).toEqual([]);
    service.close();
  });

  it('keeps an Amap key healthy when its v3 compatibility fallback succeeds', async () => {
    const id = await control.addCredential({ provider: 'amap', label: 'fallback', secret: 'fallback-key', qpsLimit: 100 });
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.startsWith('/v5/')
        ? new Response('<html>blocked</html>', { status: 200 })
        : Response.json({ status: '1', pois: [] });
    });
    const service = new ChinaDataService(addressDb, control);
    const fetchPage = (service as unknown as {
      fetchPage(provider: 'amap', target: Record<string, unknown>, page: number, accepted: number, requested: () => Promise<void>): Promise<unknown>;
    }).fetchPage.bind(service);
    await fetchPage('amap', {
      id: '110105', province: '北京市', city: '北京市', district: '朝阳区', query: '北京市朝阳区', targetCount: 5
    }, 1, 0, async () => undefined);
    expect(await control.listCredentials()).toEqual([
      expect.objectContaining({ id, status: 'healthy', failureCount: 0, quotaUsed: 1 })
    ]);
  });

  it('filters and paginates strict district coverage by administrative adcode', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{
      code: '110000', name: '北京市', level: 'province', children: [{
        code: '110100', name: '北京市', level: 'city', children: [
          { code: '110105', name: '朝阳区', level: 'district' },
          { code: '110106', name: '丰台区', level: 'district' }
        ]
      }]
    }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new ChinaDataService(addressDb, control);
    expect(await service.importAreaCity('https://example.test/areas.json', 'test-list')).toBe(4);
    const first = await service.listAreas({ provinceAdcode: '110000', cityAdcode: '110100', page: 1, pageSize: 1 });
    expect(first).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ province_adcode: '110000', city_adcode: '110100', current_count: 0 });
    expect(first.options.provinces).toContainEqual({ adcode: '110000', name: '北京市' });
    expect(first.options.cities).toContainEqual({ adcode: '110100', name: '北京市' });
    expect((await service.listAreas({ districtAdcode: '110106', page: 1, pageSize: 25 })).items)
      .toEqual([expect.objectContaining({ district_adcode: '110106', district: '丰台区' })]);
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
      components: { houseNumber: '6号', street: '阜通东大街', buildingName: '望京花园', district: '朝阳区' },
      componentVariants: {
        native: { houseNumber: '6号', street: '阜通东大街' },
        en: { houseNumber: '6', street: 'Fu tong dong da jie' },
        'zh-CN': { houseNumber: '6号', street: '阜通东大街' }
      }
    });
    expect(address?.nativeAddress).toContain('阜通东大街6号');
    expect(address?.verificationLevel).toBe('L2');
    expect(new Set(address?.evidence.map((item) => item.sourceId))).toEqual(new Set(['amap', 'tencent']));
    expect(await pickChinaCommunityAddress(addressDb, { region: '北京市', city: '北京市', district: '朝阳区' }, 'seed'))
      .toMatchObject({ components: { district: '朝阳区' } });
    expect(await pickChinaCommunityAddress(addressDb, { district: '朝阳' }, 'seed'))
      .toMatchObject({ components: { district: '朝阳区' } });
    expect(await pickChinaCommunityAddress(addressDb, { region: '北京市', city: '北京市', district: '海淀区' }, 'seed'))
      .toBeUndefined();
  });

  it('does not publish a China provider address whose trailing text prevents deterministic house-number splitting', async () => {
    const now = new Date().toISOString();
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'community-ambiguous-delivery', '光明小区', '光明', '河北省', '唐山市', '丰润区', '丰润镇',
      '文化路18号光明小区', 118.162, 39.832, 'L1', 1, now, now, now
    ).run();
    await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
      raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'amap', 'ambiguous-delivery', 'community-ambiguous-delivery', '光明小区', '文化路18号光明小区',
      118.168, 39.838, 'GCJ-02', 'ambiguous-hash', now, now
    ).run();

    expect(await countChinaCommunities(addressDb)).toBe(0);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'ambiguous-delivery')).toBeUndefined();
  });

  it('does not publish Taiwan communities through the mainland China pool', async () => {
    const now = new Date().toISOString();
    await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
      provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'community-taiwan', '明驼新城', '明驼新城', '台湾省', '台中市', '潭子区', '',
      '台中市潭子区明驼新城1号', 120.7, 24.2, 'L1', 1, now, now, now
    ).run();
    await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
      raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'amap', 'poi-community-taiwan', 'community-taiwan', '明驼新城', '台中市潭子区明驼新城1号',
      120.7, 24.2, 'GCJ-02', 'hash-community-taiwan', now, now
    ).run();

    expect(await countChinaCommunities(addressDb)).toBe(0);
    expect(await pickChinaCommunityAddress(addressDb, {}, 'strict-mainland')).toBeUndefined();
  });

  it('publishes China block identifiers but rejects mixed-language names and streets', async () => {
    const now = new Date().toISOString();
    const rows = [
      ['mixed-name', 'OASIS绿洲', '文昌街8号'],
      ['mixed-street', '长林花园', '六O南大道109号'],
      ['block-label', '学府悦园F组团', '崇贤路1号']
    ];
    for (const [id, name, providerAddress] of rows) {
      await addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
        provider_address,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        id, name, name, '重庆市', '重庆市', '沙坪坝区', '', providerAddress,
        106.45, 29.55, 'L1', 1, now, now, now
      ).run();
      await addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'amap', `poi-${id}`, id, name, providerAddress, 106.45, 29.55, 'GCJ-02', `hash-${id}`, now, now
      ).run();
    }

    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, {}, 'strict-native-language'))
      .toMatchObject({ components: { buildingName: '学府悦园F组团', street: '崇贤路' } });
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

  it('keeps accepted and rejected provider candidates with their decisions', async () => {
    const service = new ChinaDataService(addressDb, control);
    expect(await processCandidate(service, candidate('amap', 'accepted-poi', '文化路18号'))).toBe(1);
    expect(await processCandidate(service, candidate('amap', 'rejected-poi', '文化路'))).toBe(0);

    const rows = (await addressDb.prepare(`SELECT provider_poi_id,decision,rejection_reason,strategy_version
      FROM cn_ingest_candidates ORDER BY provider_poi_id`).all<Record<string, unknown>>()).results;
    expect(rows).toEqual([
      expect.objectContaining({ provider_poi_id: 'accepted-poi', decision: 'accepted', rejection_reason: '', strategy_version: 'community-poi-v7' }),
      expect.objectContaining({ provider_poi_id: 'rejected-poi', decision: 'rejected', rejection_reason: 'invalid_delivery_address', strategy_version: 'community-poi-v7' })
    ]);
  });

  it('publishes a current strict Baidu or Tencent residential candidate without requiring Amap', async () => {
    const service = new ChinaDataService(addressDb, control);
    expect(await processCandidate(service, candidate('baidu', 'baidu-only', '文化路18号'))).toBe(1);
    expect(await countChinaCommunities(addressDb)).toBe(1);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'baidu-only')).toMatchObject({
      verificationLevel: 'L1', components: { buildingName: '光明小区' }
    });
  });

  it('does not publish a non-residential provider category even when other fields look valid', async () => {
    const service = new ChinaDataService(addressDb, control);
    const invalid = { ...candidate('tencent', 'shopping-poi', '文化路18号'), typecode: '购物;商场' };
    expect(await processCandidate(service, invalid)).toBe(0);
    expect(await countChinaCommunities(addressDb)).toBe(0);
    expect(await addressDb.prepare('SELECT rejection_reason FROM cn_ingest_candidates WHERE provider_poi_id=?')
      .bind('shopping-poi').first('rejection_reason')).toBe('non_residential_provider_type');
  });

  it('rebuilds the publication layer from permanent accepted candidates', async () => {
    const service = new ChinaDataService(addressDb, control);
    await processCandidate(service, candidate('amap', 'replay-poi', '文化路18号'));
    await addressDb.prepare('DELETE FROM cn_communities_v2').run();

    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_ingest_candidates').first('total')).toBe(1);
    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_community_sources').first('total')).toBe(0);
    await service.initializeTargets();
    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2').first('total')).toBe(1);
    expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_community_sources').first('total')).toBe(1);
    expect(await countChinaCommunities(addressDb)).toBe(1);
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
    const expected = firstAddress.match(/^(.+?)([0-9]+(?:(?:弄|巷)[0-9]+)?(?:[-之][0-9]+)?号)$/u);
    expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'conflict')).toMatchObject({
      verificationLevel: 'L1', components: { street: expected?.[1], houseNumber: expected?.[2] }
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
      components: { street: '丰润区文化路', houseNumber: '18号', buildingName: '光明小区' }, verificationLevel: 'L2'
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
    ['an expired community', daysAgo(181), daysAgo(1), daysAgo(1), 'L2', 1],
    ['an invalid community date', 'not-a-date', daysAgo(1), daysAgo(1), 'L2', 0],
    ['one expired secondary source', daysAgo(1), daysAgo(1), daysAgo(181), 'L2', 1],
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
    if (published) expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'stale')).toMatchObject({ verificationLevel: expectedLevel });
    else expect(await pickChinaCommunityAddress(addressDb, { city: '唐山市' }, 'stale')).toBeUndefined();
    expect(await targetCount(service)).toBe(published);
    expect(await service.status()).toMatchObject({
      total: published,
      cross_verified: published && expectedLevel === 'L2' ? 1 : 0,
      cities: published
    });
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
    expect(status, JSON.stringify((await control.runs(10)).find((run) => run.id === runId))).toBe('succeeded');
    expect(requests).toBe(2);
  });

  it('uses all configured China map providers during a district sync', async () => {
    const now = new Date().toISOString();
    await addressDb.batch([
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110000', null, 'province', '北京市', '北京市', 'test', now),
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110100', '110000', 'city', '北京市', '北京市/北京市', 'test', now),
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind('110105', '110100', 'district', '朝阳区', '北京市/北京市/朝阳区', 'test', now)
    ]);
    for (const provider of ['amap', 'baidu', 'tencent'] as const) {
      await control.addCredential({ provider, label: provider, secret: `${provider}-test`, qpsLimit: 10 });
    }
    const requested = new Set<string>();
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const provider = url.hostname.includes('amap') ? 'amap' : url.hostname.includes('baidu') ? 'baidu' : 'tencent';
      requested.add(provider);
      const page = provider === 'amap' ? Number(url.searchParams.get('page_num')) : provider === 'baidu'
        ? Number(url.searchParams.get('page_num')) + 1 : Number(url.searchParams.get('page_index'));
      if (provider === 'amap') return Response.json({ status: '1', pois: page === 1 ? [{
        id: 'amap-poi', name: '望京花园', address: '阜通东大街6号', location: '116.47,39.995',
        pname: '北京市', cityname: '北京市', adname: '朝阳区', adcode: '110105', typecode: '120302'
      }] : [] });
      if (provider === 'baidu') return Response.json({ status: 0, results: page === 1 ? [{
        uid: 'baidu-poi', name: '望京花园', address: '阜通东大街6号', location: { lat: 40.001, lng: 116.4765 },
        province: '北京市', city: '北京市', area: '朝阳区', adcode: '110105', detail_info: { tag: '房地产;住宅区' }
      }] : [] });
      return Response.json({ status: 0, data: page === 1 ? [{
        id: 'tencent-poi', title: '望京花园', address: '阜通东大街6号', category: '房产小区:住宅区',
        location: { lat: 39.995, lng: 116.47 }, ad_info: { province: '北京市', city: '北京市', district: '朝阳区', adcode: '110105' }
      }] : [] });
    });
    const service = new ChinaDataService(addressDb, control);
    const runId = await service.start();
    let status = '';
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = String((await control.runs(10)).find((run) => run.id === runId)?.status || '');
      if (['succeeded', 'failed', 'paused_quota', 'needs_review'].includes(status)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    expect(status, JSON.stringify((await control.runs(10)).find((run) => run.id === runId))).toBe('succeeded');
    expect(requested).toEqual(new Set(['amap', 'baidu', 'tencent']));
    expect((await addressDb.prepare('SELECT DISTINCT provider FROM cn_ingest_candidates ORDER BY provider')
      .all<{ provider: string }>()).results.map((row) => row.provider)).toEqual(['amap', 'baidu', 'tencent']);
    const run = (await control.runs(10)).find((value) => value.id === runId) as { progress?: { published?: number } } | undefined;
    expect(run?.progress?.published).toBe(await countChinaCommunities(addressDb));
  });

  it('yields the event loop and tracks published counts in memory during a large sync', async () => {
    await control.addCredential({ provider: 'amap', label: 'bulk', secret: 'bulk-key', qpsLimit: 100 });
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get('page_num'));
      return Response.json({ status: '1', pois: page === 1 ? Array.from({ length: 30 }, (_, index) => ({
        id: `bulk-poi-${index}`, name: `光明${index}小区`, address: `文化路${index + 1}号`, location: '118.162,39.832',
        pname: '河北省', cityname: '唐山市', adname: '丰润区', adcode: '130208', typecode: '120302'
      })) : [] });
    });
    const service = new ChinaDataService(addressDb, control);
    const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
    let ticks = 0;
    let pumping = true;
    const pump = (): void => { ticks += 1; if (pumping) setImmediate(pump); };
    setImmediate(pump);
    try {
      await (service as unknown as {
        execute(runId: string, targets: Record<string, unknown>[], providers: string[]): Promise<void>;
      }).execute(runId, [{
        id: '130208', province: '河北省', city: '唐山市', district: '丰润区', query: '唐山市丰润区', targetCount: 40
      }], ['amap']);
    } finally {
      pumping = false;
    }
    expect(ticks).toBeGreaterThan(0);
    const run = (await control.runs(10)).find((value) => value.id === runId) as {
      status: string; progress?: { published?: number; accepted?: number };
    } | undefined;
    expect(run?.status).toBe('succeeded');
    expect(run?.progress?.accepted).toBe(30);
    expect(run?.progress?.published).toBe(30);
    expect(await countChinaCommunities(addressDb)).toBe(30);
  }, 15_000);

  describe('dual completion criteria', () => {
    const hex = (value: string): string => Buffer.from(value, 'utf8').toString('hex').toUpperCase();
    const areaCandidate = (
      province: string, city: string, district: string, adcode: string, index: number,
      provider: CommunityCandidate['provider'] = 'amap'
    ): CommunityCandidate => ({
      provider,
      providerPoiId: `${provider}-${adcode}-${index}`,
      name: `光明${adcode}${index}小区`,
      address: `文化路${index + 1}号`,
      province, city, district, township: '',
      latitude: 39.6 + index * 0.01, longitude: 118.1 + index * 0.01,
      rawLatitude: 39.606 + index * 0.01, rawLongitude: 118.106 + index * 0.01,
      rawCrs: 'GCJ-02', responseHash: `${provider}-${adcode}-${index}`,
      typecode: provider === 'amap' ? '120302' : '住宅小区', adcode
    });
    const insertAreaTarget = (adcode: string, province: string, city: string, district: string, targetCount: number) =>
      addressDb.prepare(`INSERT INTO cn_sync_area_targets(adcode,province,city,district,query,target_count,priority,enabled,updated_at)
        VALUES (?,?,?,?,?,?,?,1,?)`)
        .bind(adcode, province, city, district, `${city}${district}`, targetCount, Number(adcode), new Date().toISOString()).run();
    const seedDistrict = async (
      service: ChinaDataService, province: string, city: string, district: string, adcode: string, count: number
    ): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        expect(await upsertCandidate(service, areaCandidate(province, city, district, adcode, index))).toBe(1);
      }
    };
    const syncTarget = (adcode: string, province: string, city: string, district: string, targetCount: number) =>
      ({ id: adcode, province, city, district, query: `${city}${district}`, targetCount });
    const execute = (service: ChinaDataService, runId: string, targets: unknown[], providers: string[]) =>
      (service as unknown as {
        execute(runId: string, targets: unknown[], providers: string[]): Promise<void>;
      }).execute(runId, targets, providers);
    const amapPage = (adcode: string, adname: string, count: number) => ({
      status: '1',
      pois: Array.from({ length: count }, (_, index) => ({
        id: `poi-${adcode}-${index}`, name: `新城${adcode}${index}小区`, address: `新华路${index + 1}号`,
        location: `${(118.18 + index * 0.01).toFixed(4)},${(39.63 + index * 0.01).toFixed(4)}`,
        pname: '河北省', cityname: '唐山市', adname, adcode, typecode: '120302'
      }))
    });

    it('uses the CN min_per_node policy for automatic district baselines', async () => {
      await updateCountryPolicy(addressDb, 'CN', { minPerNode: 7 });
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{
        code: '110000', name: '北京市', level: 'province', children: [{
          code: '110100', name: '北京市', level: 'city', children: [{ code: '110105', name: '朝阳区', level: 'district' }]
        }]
      }]), { status: 200 }));
      const service = new ChinaDataService(addressDb, control);
      await service.importAreaCity('https://example.test/areas.json', 'min-per-node');
      expect(await addressDb.prepare('SELECT target_count FROM cn_sync_area_targets WHERE adcode=?')
        .bind('110105').first('target_count')).toBe(7);
    });

    it('syncs only uncovered districts and exceeds the country minimum to satisfy coverage', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 2, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 2);
      await control.addCredential({ provider: 'amap', label: 'coverage', secret: 'coverage-key', qpsLimit: 100 });
      const requestedRegions: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const region = url.searchParams.get('region') || '';
        requestedRegions.push(region);
        const page = Number(url.searchParams.get('page_num'));
        return Response.json(page === 1 && region === '130202' ? amapPage('130202', '路南区', 5) : { status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 2, providers: ['amap'] });
      await execute(service, runId, [
        syncTarget('130208', '河北省', '唐山市', '丰润区', 2),
        syncTarget('130202', '河北省', '唐山市', '路南区', 2)
      ], ['amap']);
      expect(requestedRegions.length).toBeGreaterThan(0);
      expect(requestedRegions.every((region) => region === '130202')).toBe(true);
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2 WHERE active=1').first('total')).toBe(4);
      expect(await addressDb.prepare("SELECT COUNT(*) AS total FROM cn_communities_v2 WHERE district='路南区' AND active=1")
        .first('total')).toBe(2);
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });

    it('stops immediately without requests when count and coverage targets are both met', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 2, minPerNode: 1, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 1);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 1);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 1);
      await seedDistrict(service, '河北省', '唐山市', '路南区', '130202', 1);
      await control.addCredential({ provider: 'amap', label: 'met', secret: 'met-key', qpsLimit: 100 });
      let requests = 0;
      vi.stubGlobal('fetch', async () => {
        requests += 1;
        return Response.json({ status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 2, providers: ['amap'] });
      await execute(service, runId, [
        syncTarget('130208', '河北省', '唐山市', '丰润区', 1),
        syncTarget('130202', '河北省', '唐山市', '路南区', 1)
      ], ['amap']);
      expect(requests).toBe(0);
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });

    it('prioritizes larger deficits and reports coverage_sources_exhausted without endless retries', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 3, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      await insertAreaTarget('130203', '河北省', '唐山市', '路北区', 2);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 2);
      await seedDistrict(service, '河北省', '唐山市', '路北区', '130203', 1);
      await control.addCredential({ provider: 'amap', label: 'dry', secret: 'dry-key', qpsLimit: 100 });
      const requestedRegions: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        requestedRegions.push(new URL(String(input)).searchParams.get('region') || '');
        return Response.json({ status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 3, providers: ['amap'] });
      const result = await service.runSync(runId, [
        syncTarget('130208', '河北省', '唐山市', '丰润区', 2),
        syncTarget('130203', '河北省', '唐山市', '路北区', 2),
        syncTarget('130202', '河北省', '唐山市', '路南区', 2)
      ], ['amap']);
      expect(requestedRegions).toEqual(['130202', '130203']);
      expect(result).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      await (service as unknown as { scheduleContinuation(): Promise<void> }).scheduleContinuation();
      const status = await service.status() as { nextAttemptAt: string | null };
      expect(status).toMatchObject({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      expect(status.nextAttemptAt).toBeNull();
      service.close();
    });

    it('keeps syncing districts of an under-floor province beyond min_per_node until the floor is met', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 7, minPerNode: 1, coverageRatio: 1, level1Min: 4, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 1);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 1);
      await insertAreaTarget('370102', '山东省', '济南市', '历下区', 1);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 2);
      await seedDistrict(service, '河北省', '唐山市', '路南区', '130202', 1);
      await seedDistrict(service, '山东省', '济南市', '历下区', '370102', 4);
      await control.addCredential({ provider: 'amap', label: 'floor', secret: 'floor-key', qpsLimit: 100 });
      const requestedRegions: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const region = url.searchParams.get('region') || '';
        requestedRegions.push(region);
        const page = Number(url.searchParams.get('page_num'));
        const district = region === '130208' ? '丰润区' : '路南区';
        return Response.json(page === 1 ? amapPage(region, district, 1) : { status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 3, providers: ['amap'] });
      await execute(service, runId, [
        syncTarget('370102', '山东省', '济南市', '历下区', 1),
        syncTarget('130208', '河北省', '唐山市', '丰润区', 1),
        syncTarget('130202', '河北省', '唐山市', '路南区', 1)
      ], ['amap']);
      expect(requestedRegions).toEqual(['130208']);
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2 WHERE active=1').first('total')).toBe(8);
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });

    it('settles a zero-request coverage run into source_limited with a quota-boundary horizon', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 1);
      await control.addCredential({ provider: 'amap', label: 'noop', secret: 'noop-key', qpsLimit: 100 });
      // All 8 pages consumed on a previous run without a terminal status: page overflow, not 'exhausted'.
      await addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,updated_at,strategy_version)
        VALUES ('amap','130208',9,'baseline',0,?,'community-poi-v7')`).bind(new Date().toISOString()).run();
      let requests = 0;
      vi.stubGlobal('fetch', async () => {
        requests += 1;
        return Response.json({ status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
      const result = await service.runSync(runId, [syncTarget('130208', '河北省', '唐山市', '丰润区', 2)], ['amap']);
      expect(requests).toBe(0);
      expect(result).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
      await (service as unknown as { scheduleContinuation(): Promise<void> }).scheduleContinuation();
      const status = await service.status() as { nextAttemptAt: string | null };
      expect(status).toMatchObject({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      expect(status.nextAttemptAt).toBeNull();
      service.close();
    });

    it('retries an amap-exhausted district with tencent before baidu on fresh per-provider checkpoints', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 1);
      for (const provider of ['amap', 'baidu', 'tencent'] as const) {
        await control.addCredential({ provider, label: provider, secret: `${provider}-key`, qpsLimit: 100 });
      }
      await addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,updated_at,strategy_version)
        VALUES ('amap','130208',3,'exhausted',0,?,'community-poi-v7')`).bind(new Date().toISOString()).run();
      const order: string[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const provider = url.hostname.includes('amap') ? 'amap' : url.hostname.includes('baidu') ? 'baidu' : 'tencent';
        order.push(provider);
        if (provider === 'amap') return Response.json({ status: '1', pois: [] });
        if (provider === 'tencent') return Response.json({ status: 0, data: [] });
        const page = Number(url.searchParams.get('page_num')) + 1;
        return Response.json({ status: 0, results: page === 1 ? [{
          uid: 'baidu-fill', name: '幸福小区', address: '建设路8号', location: { lat: 39.845, lng: 118.175 },
          province: '河北省', city: '唐山市', area: '丰润区', adcode: '130208', detail_info: { tag: '房地产;住宅区' }
        }] : [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap', 'baidu', 'tencent'] });
      const result = await service.runSync(runId, [syncTarget('130208', '河北省', '唐山市', '丰润区', 2)], ['amap', 'baidu', 'tencent']);
      expect(order).toEqual(['tencent', 'baidu']);
      expect(result.syncState).not.toBe('source_limited');
      expect(await addressDb.prepare("SELECT decision FROM cn_ingest_candidates WHERE provider='baidu' AND provider_poi_id='baidu-fill'")
        .first('decision')).toBe('accepted');
      expect(await countChinaCommunities(addressDb)).toBe(2);
      const checkpoints = (await addressDb.prepare("SELECT provider,status FROM cn_sync_checkpoints WHERE city='130208' ORDER BY provider")
        .all<{ provider: string; status: string }>()).results;
      expect(checkpoints).toEqual([
        { provider: 'amap', status: 'exhausted' },
        { provider: 'baidu', status: 'baseline' },
        { provider: 'tencent', status: 'exhausted' }
      ]);
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });

    it('keeps filling uncovered districts after the former 1.2x threshold', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 5, minPerNode: 2, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 2);
      await insertAreaTarget('130202', '河北省', '唐山市', '路南区', 2);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 6);
      await control.addCredential({ provider: 'amap', label: 'cap', secret: 'cap-key', qpsLimit: 100 });
      let requests = 0;
      vi.stubGlobal('fetch', async () => {
        requests += 1;
        return Response.json({ status: '1', pois: [] });
      });
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 2, providers: ['amap'] });
      const result = await service.runSync(runId, [
        syncTarget('130208', '河北省', '唐山市', '丰润区', 2),
        syncTarget('130202', '河北省', '唐山市', '路南区', 2)
      ], ['amap']);
      expect(requests).toBeGreaterThan(0);
      expect(result).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      await (service as unknown as { scheduleContinuation(): Promise<void> }).scheduleContinuation();
      expect(await service.status()).toMatchObject({
        syncState: 'source_limited', waitReason: 'coverage_sources_exhausted', nextAttemptAt: null
      });
      service.close();
    });

    it('prunes overridden node excess keeping cross-verified communities and audits the retirement', async () => {
      await updateCountryPolicy(addressDb, 'CN', {
        targetCount: 1, minPerNode: 1, coverageRatio: 1, level1Min: 0, level2Min: 0
      });
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 1);
      const service = new ChinaDataService(addressDb, control);
      await seedDistrict(service, '河北省', '唐山市', '丰润区', '130208', 3);
      expect(await upsertCandidate(service, {
        ...areaCandidate('河北省', '唐山市', '丰润区', '130208', 0, 'tencent'),
        providerPoiId: 'tencent-cross-0'
      })).toBe(0);
      const districtKey = `CN:dist:${hex('河北省')}:${hex('唐山市')}:${hex('丰润区')}`;
      await addressDb.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,total_count,updated_at)
        VALUES (?,?,?,?,?,?,?)`)
        .bind(districtKey, `CN:loc:${hex('河北省')}:${hex('唐山市')}`, 'CN', 3, '丰润区', 3, new Date().toISOString()).run();
      await upsertNodeTarget(addressDb, districtKey, 1);
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 0, providers: ['amap'] });
      await execute(service, runId, [], ['amap']);
      const survivors = (await addressDb.prepare(`SELECT canonical_name,verification_level FROM cn_communities_v2
        WHERE active=1 ORDER BY canonical_name`).all<Record<string, unknown>>()).results;
      expect(survivors).toEqual([expect.objectContaining({ canonical_name: '光明1302080小区', verification_level: 'L2' })]);
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2 WHERE active=0').first('total')).toBe(2);
      const audit = (await control.audits(20)).find((entry) => entry.action === 'china.communities.prune');
      expect(audit).toMatchObject({ actor: 'system', target: districtKey });
      expect((await control.runs(10)).find((run) => run.id === runId)?.status).toBe('succeeded');
    });
  });

  describe('township-level query subdivision', () => {
    const insertAdminArea = (adcode: string, parent: string | null, level: string, name: string) =>
      addressDb.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES (?,?,?,?,?,?,?)`).bind(adcode, parent, level, name, name, 'test', new Date().toISOString()).run();
    const insertAreaTarget = (adcode: string, province: string, city: string, district: string, targetCount: number) =>
      addressDb.prepare(`INSERT INTO cn_sync_area_targets(adcode,province,city,district,query,target_count,priority,enabled,updated_at)
        VALUES (?,?,?,?,?,?,?,1,?)`)
        .bind(adcode, province, city, district, `${city}${district}`, targetCount, Number(adcode), new Date().toISOString()).run();
    const insertCheckpoint = (provider: string, city: string, page: number, status: string) =>
      addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,updated_at,strategy_version)
        VALUES (?,?,?,?,0,?,'community-poi-v7')`).bind(provider, city, page, status, new Date().toISOString()).run();
    const fengrunAreas = async (): Promise<void> => {
      await insertAdminArea('130000', null, 'province', '河北省');
      await insertAdminArea('1302', '130000', 'city', '唐山市');
      await insertAdminArea('130208', '1302', 'district', '丰润区');
      await insertAdminArea('130208001', '130208', 'township', '甲镇');
      await insertAdminArea('130208002', '130208', 'township', '乙镇');
      await insertAreaTarget('130208', '河北省', '唐山市', '丰润区', 3);
    };
    const fengrunTarget = { id: '130208', province: '河北省', city: '唐山市', district: '丰润区', query: '唐山市丰润区', targetCount: 3 };
    const townshipPois = (prefix: string, count: number, road = '建设路') => ({
      status: '1',
      pois: Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`, name: `${prefix}${index}小区`, address: `${road}${index + 1}号`,
        location: `${(118.2 + index * 0.01).toFixed(4)},${(39.65 + index * 0.01).toFixed(4)}`,
        pname: '河北省', cityname: '唐山市', adname: '丰润区', adcode: '130208', typecode: '120302'
      }))
    });

    it('subdivides a terminal district window into resumable round-robin township queries', async () => {
      await updateCountryPolicy(addressDb, 'CN', { targetCount: 50, minPerNode: 3, coverageRatio: 1, level1Min: 0, level2Min: 0 });
      await fengrunAreas();
      await control.addCredential({ provider: 'amap', label: 'township', secret: 'township-key', qpsLimit: 100 });
      await insertCheckpoint('amap', '130208', 9, 'enrichment');
      await insertCheckpoint('amap', '130208001', 2, 'baseline');
      const calls: Array<{ keywords: string; page: number; region: string }> = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const keywords = url.searchParams.get('keywords') || '';
        const page = Number(url.searchParams.get('page_num'));
        calls.push({ keywords, page, region: url.searchParams.get('region') || '' });
        if (keywords === '甲镇' && page === 2) return Response.json(townshipPois('甲', 2));
        if (keywords === '乙镇' && page === 1) return Response.json(townshipPois('乙', 1, '振兴路'));
        return Response.json({ status: '1', pois: [] });
      });
      const service = new ChinaDataService(addressDb, control);
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
      const result = await service.runSync(runId, [fengrunTarget], ['amap']);
      expect(calls).toEqual([
        { keywords: '甲镇', page: 2, region: '130208' },
        { keywords: '乙镇', page: 1, region: '130208' },
        { keywords: '甲镇', page: 3, region: '130208' },
        { keywords: '乙镇', page: 2, region: '130208' }
      ]);
      expect(result.syncState).toBe('below_target');
      expect(await countChinaCommunities(addressDb)).toBe(3);
      const checkpoints = (await addressDb.prepare(`SELECT city,page,status FROM cn_sync_checkpoints
        WHERE provider='amap' AND city IN ('130208001','130208002') ORDER BY city`).all<Record<string, unknown>>()).results;
      expect(checkpoints).toEqual([
        { city: '130208001', page: 3, status: 'exhausted' },
        { city: '130208002', page: 2, status: 'exhausted' }
      ]);
      const run = (await control.runs(10)).find((value) => value.id === runId) as {
        progress?: { requests?: number; accepted?: number };
      } | undefined;
      expect(run?.progress).toMatchObject({ requests: 4, accepted: 3 });
    });

    it('publishes overlapping township results once via the provider POI identity', async () => {
      await updateCountryPolicy(addressDb, 'CN', { targetCount: 50, minPerNode: 3, coverageRatio: 1, level1Min: 0, level2Min: 0 });
      await fengrunAreas();
      await control.addCredential({ provider: 'amap', label: 'overlap', secret: 'overlap-key', qpsLimit: 100 });
      await insertCheckpoint('amap', '130208', 9, 'enrichment');
      const shared = townshipPois('共享', 1);
      const calls: Array<{ keywords: string; page: number }> = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get('page_num'));
        calls.push({ keywords: url.searchParams.get('keywords') || '', page });
        return Response.json(page === 1 ? shared : { status: '1', pois: [] });
      });
      const service = new ChinaDataService(addressDb, control);
      const runId = await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] });
      await service.runSync(runId, [fengrunTarget], ['amap']);
      expect(calls).toEqual([
        { keywords: '甲镇', page: 1 }, { keywords: '乙镇', page: 1 },
        { keywords: '甲镇', page: 2 }, { keywords: '乙镇', page: 2 }
      ]);
      expect(await countChinaCommunities(addressDb)).toBe(1);
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_ingest_candidates').first('total')).toBe(1);
      expect(await addressDb.prepare('SELECT COUNT(*) AS total FROM cn_community_sources').first('total')).toBe(1);
    });

    it('keeps querying unconsumed townships before settling coverage_sources_exhausted', async () => {
      await updateCountryPolicy(addressDb, 'CN', { targetCount: 1, minPerNode: 3, coverageRatio: 1, level1Min: 0, level2Min: 0 });
      await fengrunAreas();
      const service = new ChinaDataService(addressDb, control);
      expect(await upsertCandidate(service, candidate('amap', 'seed-poi', '文化路18号'))).toBe(1);
      await control.addCredential({ provider: 'amap', label: 'terminal', secret: 'terminal-key', qpsLimit: 100 });
      await insertCheckpoint('amap', '130208', 3, 'exhausted');
      await insertCheckpoint('amap', '130208001', 1, 'exhausted');
      let requests = 0;
      vi.stubGlobal('fetch', async () => {
        requests += 1;
        return Response.json({ status: '1', pois: [] });
      });
      const first = await service.runSync(
        await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] }),
        [fengrunTarget], ['amap']
      );
      expect(requests).toBe(1);
      expect(first).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
      const second = await service.runSync(
        await control.createRun('china-communities', { mode: 'test', targets: 1, providers: ['amap'] }),
        [fengrunTarget], ['amap']
      );
      expect(requests).toBe(1);
      expect(second).toEqual({ syncState: 'source_limited', waitReason: 'coverage_sources_exhausted' });
    });

    it('accepts municipality candidates whose provider city is the province itself', async () => {
      await insertAdminArea('50', null, 'province', '重庆市');
      await insertAdminArea('5002', '50', 'city', '重庆郊县');
      await insertAdminArea('500101', '5002', 'district', '万州区');
      const service = new ChinaDataService(addressDb, control);
      const target = { id: '500101', province: '重庆市', city: '重庆郊县', district: '万州区', query: '重庆郊县万州区', targetCount: 5 };
      const chongqing: CommunityCandidate = {
        provider: 'amap', providerPoiId: 'cq-1', name: '滨江小区', address: '滨江路12号',
        province: '重庆市', city: '重庆市', district: '万州区', township: '', latitude: 30.81, longitude: 108.4,
        rawLatitude: 30.815, rawLongitude: 108.405, rawCrs: 'GCJ-02', responseHash: 'cq-hash', typecode: '120302', adcode: '500101'
      };
      const internals = service as unknown as {
        processCandidate(value: CommunityCandidate, target: Record<string, unknown>): Promise<number>;
        targetCount(target: Record<string, unknown>): Promise<number>;
      };
      expect(await internals.processCandidate(chongqing, target)).toBe(1);
      expect(await internals.targetCount(target)).toBe(1);
    });

    it('re-accepts stored administrative_mismatch candidates without spending quota', async () => {
      await insertAdminArea('50', null, 'province', '重庆市');
      await insertAdminArea('5002', '50', 'city', '重庆郊县');
      await insertAdminArea('500101', '5002', 'district', '万州区');
      const now = new Date().toISOString();
      await addressDb.prepare(`INSERT INTO cn_ingest_candidates(provider,provider_poi_id,target_adcode,name,address,province,city,
        district,township,longitude,latitude,raw_longitude,raw_latitude,raw_crs,typecode,adcode,response_hash,decision,
        rejection_reason,strategy_version,first_seen_at,last_seen_at)
        VALUES ('amap','cq-replay','500101','江畔人家','滨江路8号','重庆市','重庆市','万州区','',108.41,30.82,108.415,30.825,
          'GCJ-02','120302','500101','hash-replay','rejected','administrative_mismatch','community-poi-v6',?,?)`)
        .bind(now, now).run();
      const service = new ChinaDataService(addressDb, control);
      await service.initializeTargets();
      service.close();
      expect(await addressDb.prepare("SELECT decision,rejection_reason FROM cn_ingest_candidates WHERE provider_poi_id='cq-replay'")
        .first<Record<string, unknown>>()).toMatchObject({ decision: 'accepted', rejection_reason: '' });
      expect(await countChinaCommunities(addressDb)).toBe(1);
    });
  });
});
