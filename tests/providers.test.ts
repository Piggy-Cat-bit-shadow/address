import { describe, expect, it } from 'vitest';
import { countryByCode } from '../src/domain/countries';
import { generateBundle } from '../src/domain/generator';
import { fetchExternalCandidates, searchExternalLocations } from '../server/api/services/external-providers';
import { localizeAddress } from '../server/api/services/address-localizer';
import lungOnHouse from './fixtures/hk-als-lung-on-house.json';

const country = (code: 'CN' | 'SG' | 'GB' | 'HK') => {
  const value = countryByCode.get(code);
  if (!value) throw new Error(code);
  return value;
};

describe('registered address providers', () => {
  it('uses Hong Kong ALS official bilingual components for Lung On House', async () => {
    let requestUrl = '';
    let requestHeaders = new Headers();
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify(lungOnHouse), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await fetchExternalCandidates(country('HK'), true, { q: '龍安樓' }, {}, fetcher as typeof fetch);
    expect(result.sources).toEqual(['hk-als']);
    expect(new URL(requestUrl).searchParams.get('q')).toBe('龍安樓');
    expect(requestHeaders.get('accept-language')).toBe('en,zh-Hant');
    expect(result.candidates[0]).toMatchObject({
      id: 'hk-als-3790622475T20050430',
      coordinates: { latitude: 22.34135, longitude: 114.19278 },
      components: {
        houseNumber: '103號', street: '正德街', buildingName: '龍安樓', locality: '黃大仙區',
        dependentLocality: '黃大仙下邨(二區)', district: '黃大仙區', admin1: '九龍'
      },
      componentVariants: {
        en: {
          houseNumber: '103', street: 'CHING TAK STREET', buildingName: 'LUNG ON HOUSE',
          dependentLocality: 'LOWER WONG TAI SIN (II) ESTATE', district: 'WONG TAI SIN DISTRICT', admin1: 'KOWLOON'
        },
        'zh-CN': {
          houseNumber: '103号', street: '正德街', buildingName: '龙安楼', district: '黄大仙区', admin1: '九龙'
        }
      }
    });
    expect(result.candidates[0].evidence).toContainEqual(expect.objectContaining({ sourceId: 'hk-als', type: 'residential_use' }));
    const localized = await localizeAddress(result.candidates[0], country('HK'), {});
    expect(localized.addressVariants.native).toContain('正德街103號');
    expect(localized.addressVariants.en).toContain('103 CHING TAK STREET');
    expect(localized.addressVariants['zh-CN']).toContain('龙安楼');
  });

  it('parses a residential Amap community with a numbered street', async () => {
    const fetcher = async () => new Response(JSON.stringify({ status: '1', pois: [{
      id: 'B0TEST', name: '怡海花园', address: '南四环西路129号', location: '116.301270,39.833836',
      pname: '北京市', cityname: '北京市', adname: '丰台区', type: '商务住宅;住宅区;住宅小区', typecode: '120302'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const result = await fetchExternalCandidates(country('CN'), true, { city: '北京市' }, { amap: 'test' }, fetcher as typeof fetch);
    expect(result.sources).toEqual(['amap']);
    expect(result.candidates[0]).toMatchObject({ propertyType: 'apartment', components: { houseNumber: '129号', street: '南四环西路', buildingName: '怡海花园', district: '丰台区' } });
    const bundle = generateBundle(result.candidates[0], false, 'cn-community', undefined);
    expect(bundle.address.addressVariants.native).toBe('北京市丰台区南四环西路129号怡海花园');
    expect(bundle.address.components.unit).toBeUndefined();
    expect(bundle.address.unitProvenance).not.toBe('synthetic');
    expect(bundle.generatedUnit).toBeUndefined();
    expect(bundle.addressFormats.native.singleLine).not.toMatch(/栋|单元|室$/u);
    expect(bundle.addressFormats.en.singleLine).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('rejects a China community without a source-provided premise number', async () => {
    const fetcher = async () => new Response(JSON.stringify({ status: '1', pois: [{
      id: 'B0FALLBACK', name: '光明小区', address: '文化路', location: '118.162000,39.832000',
      pname: '河北省', cityname: '唐山市', adname: '丰润区', type: '商务住宅;住宅区;住宅小区', typecode: '120302'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const ordinary = await fetchExternalCandidates(country('CN'), false, { city: '唐山市' }, { amap: 'test' }, fetcher as typeof fetch);
    const residential = await fetchExternalCandidates(country('CN'), true, { city: '唐山市' }, { amap: 'test' }, fetcher as typeof fetch);
    expect(ordinary.candidates).toEqual([]);
    expect(residential.candidates).toEqual([]);
  });

  it('rejects an Amap community when the provider omits the road address', async () => {
    const fetcher = async () => new Response(JSON.stringify({ status: '1', pois: [{
      id: 'B0NOROAD', name: '保利花园', address: [], location: '108.950000,34.900000',
      pname: '陕西省', cityname: '铜川市', adname: '印台区', type: '商务住宅;住宅区;住宅小区', typecode: '120302'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const first = await fetchExternalCandidates(country('CN'), false, { city: '铜川市' }, { amap: 'test' }, fetcher as typeof fetch);
    const second = await fetchExternalCandidates(country('CN'), false, { city: '铜川市' }, { amap: 'test' }, fetcher as typeof fetch);
    expect(first.candidates).toEqual([]);
    expect(second.candidates).toEqual([]);
  });

  it.each([
    '文化路光明小区',
    '光明小区3号楼'
  ])('rejects an Amap community result without an explicit premise number: %s', async (address) => {
    const fetcher = async () => new Response(JSON.stringify({ status: '1', pois: [{
      id: `B0EDGE-${address}`, name: '光明小区', address, location: '118.162000,39.832000',
      pname: '河北省', cityname: '唐山市', adname: '丰润区', type: '商务住宅;住宅区;住宅小区', typecode: '120302'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const result = await fetchExternalCandidates(country('CN'), false, { city: '唐山市' }, { amap: 'test' }, fetcher as typeof fetch);
    expect(result.candidates).toEqual([]);
  });

  it('keeps a complete China English address when translation fails after an Amap fallback', async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://restapi.amap.com/')) {
        return new Response(JSON.stringify({ status: '1', pois: [{
          id: 'B0E2E', name: '丰润春城', address: '文化路987号', location: '118.162000,39.832000',
          pname: '河北省', cityname: '唐山市', adname: '丰润区', type: '商务住宅;住宅区;住宅小区', typecode: '120302'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('translation unavailable');
    };
    const result = await fetchExternalCandidates(country('CN'), false, { city: '唐山市' }, { amap: 'test' }, fetcher as typeof fetch);
    const localized = await localizeAddress(result.candidates[0], country('CN'), {}, fetcher as typeof fetch);
    const bundle = generateBundle(localized, false, 'cn-provider-e2e', undefined);

    expect(bundle.addressFormats.native.singleLine).toBe('河北省唐山市丰润区文化路987号丰润春城');
    expect(bundle.addressFormats.en.singleLine).toBe('Fengrun Chuncheng, 987 Wenhua Road, Fengrun District, Tangshan City, Hebei Province, CHINA');
    expect(bundle.addressFormats.en.singleLine).not.toMatch(/[\u3400-\u9fff]|064000/u);
  });

  it('keeps China on the Chinese Amap pipeline when no community is returned', async () => {
    const urls: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ status: '1', pois: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await fetchExternalCandidates(country('CN'), false, {}, { amap: 'test', geoapify: 'test' }, fetcher as typeof fetch);
    expect(result).toEqual({ candidates: [], sources: ['amap'] });
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.startsWith('https://restapi.amap.com/') && url.includes(encodeURIComponent('北京市')))).toBe(true);
  });

  it('parses a OneMap address record', async () => {
    const fetcher = async () => new Response(JSON.stringify({ results: [{
      SEARCHVAL: 'NOVENA SQUARE', BLK_NO: '238', ROAD_NAME: 'THOMSON ROAD', ADDRESS: '238 THOMSON ROAD',
      POSTAL: '307683', LATITUDE: '1.319967', LONGITUDE: '103.843851'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const result = await fetchExternalCandidates(country('SG'), false, { postcode: '307683' }, { oneMap: 'test' }, fetcher as typeof fetch);
    expect(result.sources).toEqual(['onemap']);
    expect(result.candidates[0].components).toMatchObject({ houseNumber: '238', street: 'THOMSON ROAD', postcode: '307683' });
    expect(result.candidates[0].id).toBe('onemap-sg-307683');
  });

  it('keeps OneMap records distinct when the source URL has no path identifier', async () => {
    const fetcher = async () => new Response(JSON.stringify({ results: [{
      SEARCHVAL: 'BLOCK ONE', BLK_NO: '1', ROAD_NAME: 'TEST ROAD', ADDRESS: '1 TEST ROAD',
      POSTAL: '100001', LATITUDE: '1.30', LONGITUDE: '103.80'
    }, {
      SEARCHVAL: 'BLOCK TWO', BLK_NO: '2', ROAD_NAME: 'TEST ROAD', ADDRESS: '2 TEST ROAD',
      POSTAL: '100002', LATITUDE: '1.31', LONGITUDE: '103.81'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const result = await fetchExternalCandidates(country('SG'), false, {}, { oneMap: 'test' }, fetcher as typeof fetch);
    expect(result.candidates.map(({ id }) => id)).toEqual(['onemap-sg-100001', 'onemap-sg-100002']);
  });

  it('uses Geoapify geocoding plus residential building lookup', async () => {
    let request = 0;
    const fetcher = async () => {
      request += 1;
      const body = request === 1
        ? { features: [{ properties: { lat: 53.4808, lon: -2.2426 } }] }
        : { features: [{ properties: {
          country_code: 'gb', housenumber: '19', street: 'Dickinson Street', city: 'Manchester', state: 'England',
          postcode: 'M1 4LX', formatted: '19 Dickinson Street, Manchester, M1 4LX, United Kingdom', lat: 53.478, lon: -2.24,
          datasource: { raw: { building: 'residential' } }
        } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await fetchExternalCandidates(country('GB'), true, { city: 'Manchester' }, { geoapify: 'test' }, fetcher as typeof fetch);
    expect(result.sources).toEqual(['geoapify']);
    expect(result.candidates[0]).toMatchObject({ propertyType: 'residential', components: { locality: 'Manchester', houseNumber: '19' } });
  });

  it('marks Geoapify multi-unit building tags as apartments', async () => {
    const fetcher = async () => new Response(JSON.stringify({ features: [{ properties: {
      country_code: 'gb', housenumber: '41', street: 'King Street', city: 'Manchester', state: 'England',
      postcode: 'M2 7AT', formatted: '41 King Street, Manchester, M2 7AT, United Kingdom', lat: 53.481, lon: -2.247,
      datasource: { raw: { building: 'apartments', 'building:units': 48 } }
    } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const result = await fetchExternalCandidates(country('GB'), true, {}, { geoapify: 'test' }, fetcher as typeof fetch);
    expect(result.candidates[0].propertyType).toBe('apartment');
    expect(result.candidates[0].evidence).toContainEqual(expect.objectContaining({ type: 'building_status' }));
  });

  it('accepts real premises without house numbers and falls back to named accommodation', async () => {
    let request = 0;
    const fetcher = async () => {
      request += 1;
      const properties = request === 1
        ? { country_code: 'gb', postcode: 'SW1A 2AA', formatted: 'SW1A 2AA, London, United Kingdom', lat: 51.5, lon: -0.12 }
        : {
          country_code: 'gb', name: 'Test Residence', street: 'Whitehall', city: 'London', postcode: 'SW1A 2AA',
          formatted: 'Test Residence, Whitehall, London SW1A 2AA, United Kingdom', lat: 51.501, lon: -0.126
        };
      return new Response(JSON.stringify({ features: [{ properties }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await fetchExternalCandidates(country('GB'), false, {}, { geoapify: 'test' }, fetcher as typeof fetch);
    expect(request).toBe(2);
    expect(result.sources).toEqual(['geoapify']);
    expect(result.candidates[0].components).toMatchObject({ houseNumber: '', street: 'Whitehall', buildingName: 'Test Residence', locality: 'London' });
  });

  it('discovers arbitrary cities for the custom combobox', async () => {
    const fetcher = async () => new Response(JSON.stringify({ results: [
      { city: 'Sacramento', state: 'California' }, { city: 'West Sacramento', state: 'California' }
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const result = await searchExternalLocations(countryByCode.get('US')!, 'city', 'Sacram', undefined, 'test', fetcher as typeof fetch);
    expect(result.cities).toEqual(['Sacramento', 'West Sacramento']);
  });
});
