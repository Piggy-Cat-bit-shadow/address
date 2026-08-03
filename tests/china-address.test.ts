import { describe, expect, it } from 'vitest';
import { formatAddressPresentation } from '../src/domain/address-format';
import { countryByCode } from '../src/domain/countries';
import { generateBundle } from '../src/domain/generator';
import type { AddressComponents, VerifiedAddress } from '../src/domain/types';
import { normalizeChinaDeliveryAddress, normalizeChinaProviderAddress } from '../server/china/quality';

const now = new Date('2026-07-20T00:00:00.000Z');

const chinaAddress = (municipality = false): VerifiedAddress => {
  const native: AddressComponents = municipality ? {
    admin1: '北京市', locality: '北京市', district: '朝阳区', dependentLocality: '望京街道',
    street: '阜通东大街', houseNumber: '6号', buildingName: '望京花园', postcode: '100102'
  } : {
    admin1: '河北省', locality: '唐山市', district: '丰润区', dependentLocality: '丰润镇',
    street: '文化路', houseNumber: '18号', buildingName: '光明小区', postcode: '064000'
  };
  const en: AddressComponents = municipality ? {
    admin1: 'Beijing', locality: 'Beijing', district: 'Chaoyang District', dependentLocality: 'Wangjing Subdistrict',
    street: 'Futong East Street', houseNumber: '6', buildingName: 'Wangjing Garden', postcode: '100102'
  } : {
    admin1: 'Hebei Province', locality: 'Tangshan City', district: 'Fengrun District', dependentLocality: 'Fengrun Town',
    street: 'Wenhua Road', houseNumber: '18', buildingName: 'Guangming Residential Community', postcode: '064000'
  };
  const postcode = native.postcode;
  return {
    id: municipality ? 'cn-municipality' : 'cn-hierarchy',
    countryCode: 'CN',
    nativeAddress: `${native.admin1}${native.locality}${native.district}${native.street}${native.houseNumber}${native.buildingName} 邮编${postcode}`,
    formattedAddress: `source address ${postcode}`,
    nativeLanguage: 'zh-CN',
    addressVariants: {
      native: `source native ${postcode}`,
      en: `source English ${postcode}`,
      'zh-CN': `source Chinese ${postcode}`
    },
    components: native,
    componentVariants: { native, en, 'zh-CN': { ...native } },
    coordinates: municipality
      ? { latitude: 39.995, longitude: 116.47 }
      : { latitude: 39.832, longitude: 118.162 },
    addressStatus: 'verified',
    propertyType: 'apartment',
    unitStatus: 'building_only',
    unitProvenance: 'none',
    matchLevel: 'premise',
    verificationLevel: 'L2',
    sourceVersion: 'cn-test-v1',
    sourceUpdatedAt: '2026-07-16',
    verifiedAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-23T00:00:00.000Z',
    evidence: [{
      sourceId: 'cn-test', sourceName: 'China address fixture', sourceUrl: 'https://example.test/cn',
      sourceFamily: 'fixture', type: 'address_existence', value: 'same-chain fixture', observedAt: '2026-07-16'
    }],
    exclusionFlags: []
  };
};

describe('China address domain rules', () => {
  it('removes duplicated administrative prefixes and navigation distances from provider addresses', () => {
    expect(normalizeChinaProviderAddress('河北省保定市定兴县昌盛大街199号', {
      province: '河北省', city: '保定市', district: '定兴县'
    })).toBe('昌盛大街199号');
    expect(normalizeChinaProviderAddress('北京市怀柔区雁栖镇十八路30号', {
      province: '北京市', city: '北京市', district: '怀柔区', township: '雁栖镇'
    })).toBe('十八路30号');
    expect(normalizeChinaDeliveryAddress('金融大街55号西北方向120米电力局生活小区')).toBe('金融大街55号电力局生活小区');
  });

  it('does not remove a normal road name without an exact administrative prefix', () => {
    expect(normalizeChinaProviderAddress('河北大街199号', {
      province: '河北省', city: '保定市', district: '定兴县'
    })).toBe('河北大街199号');
  });

  it('shows postcode as a standalone field but keeps it out of filters and the complete address', () => {
    const schema = countryByCode.get('CN')!.addressSchema;
    expect(schema.filters).toEqual(['region', 'city', 'district']);
    expect(schema.resultFields.map(({ field }) => field)).toContain('postcode');
    expect(schema.resultFields.map(({ field }) => field).slice(0, 2)).toEqual(['buildingName', 'street']);
  });

  it('formats the verified hierarchy with explicitly synthetic China indoor components', () => {
    const address = chinaAddress();
    const bundle = generateBundle(address, true, 'cn-hierarchy-seed', undefined, now);
    expect(bundle.generatedUnit).toMatchObject({ provenance: 'synthetic', unitProvenance: 'synthetic' });
    expect(Number(bundle.generatedUnit?.components.building)).toBeGreaterThanOrEqual(1);
    expect(Number(bundle.generatedUnit?.components.building)).toBeLessThanOrEqual(3);
    expect(Number(bundle.generatedUnit?.components.unit)).toBeGreaterThanOrEqual(1);
    expect(Number(bundle.generatedUnit?.components.unit)).toBeLessThanOrEqual(3);
    expect(bundle.generatedUnit?.components.room).toMatch(/^[2-6]0[1-4]$/u);
    const presented = bundle.address.components;
    expect(presented).toEqual(address.components);
    expect(bundle.address.coordinates).toEqual(address.coordinates);
    expect(bundle.address.unitProvenance).toBe('none');
    expect(bundle.addressFormats.native.singleLine).toBe(`河北省唐山市丰润区丰润镇文化路18号光明小区${bundle.generatedUnit?.variants.native}`);
    expect(bundle.addressFormats['zh-CN'].singleLine).toBe(`河北省唐山市丰润区丰润镇文化路18号光明小区${bundle.generatedUnit?.variants['zh-CN']}`);

    const english = bundle.addressFormats.en.singleLine;
    const englishCommunity = 'Guangming Residential Community';
    const ordered = [
      bundle.generatedUnit!.variants.en, englishCommunity, '18 Wenhua Road', 'Fengrun Town',
      'Fengrun District', 'Tangshan City', 'Hebei Province', 'CHINA'
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(english.indexOf(ordered[index - 1])).toBeLessThan(english.indexOf(ordered[index]));
    }
    expect(english).not.toMatch(/[\u3400-\u9fff]/u);
    for (const language of ['native', 'en', 'zh-CN'] as const) {
      expect(bundle.addressFormats[language].singleLine).not.toContain(address.components.postcode);
    }
    expect(new URL(bundle.googleMaps.openUrl).searchParams.get('query')).toBe('39.832,118.162');
    const searchQuery = new URL(bundle.googleMaps.searchUrl!).searchParams.get('query')!;
    expect(searchQuery).toContain('文化路');
    expect(searchQuery).toContain('光明小区');
    expect(bundle.googleMaps.amapUrl).toContain('uri.amap.com/marker');
    expect(generateBundle(address, true, 'cn-hierarchy-seed', undefined, now).generatedUnit).toEqual(bundle.generatedUnit);
    expect(generateBundle(address, true, 'cn-hierarchy-seed', undefined, now).address.components).toEqual(presented);
  });

  it('keeps the verified provider community and ignores legacy nearby OSM hints', () => {
    const address = { ...chinaAddress(), nearbyCommunities: [{ zh: '天湖城', en: 'Tianhucheng' }] };
    const bundle = generateBundle(address, true, 'cn-community-seed', undefined, now);
    expect(bundle.address.components.buildingName).toBe('光明小区');
    expect(bundle.address.componentVariants.en.buildingName).toBe('Guangming Residential Community');
    expect(bundle.addressFormats.native.singleLine).toContain('光明小区');
    expect(generateBundle(address, true, 'cn-community-seed', undefined, now).address.components.buildingName).toBe('光明小区');
  });

  it('deduplicates a municipality in Chinese and English output', () => {
    const bundle = generateBundle(chinaAddress(true), true, 'cn-municipality-seed', undefined, now);
    for (const language of ['native', 'zh-CN'] as const) {
      expect(bundle.addressFormats[language].singleLine.match(/北京市/g)).toHaveLength(1);
      expect(bundle.addressFormats[language].singleLine).not.toContain('100102');
    }
    const english = bundle.addressFormats.en.singleLine;
    expect(english.match(/Beijing/g)).toHaveLength(1);
    expect(english).toContain('Chaoyang District, Beijing, CHINA');
    expect(english).not.toContain('100102');
    expect(english).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('normalizes a Chinese lane suffix without dropping the English house number', () => {
    const address = chinaAddress();
    address.componentVariants.en = {
      ...address.componentVariants.en,
      street: 'Xiaomuqiao Road',
      houseNumber: '360弄'
    };
    const english = formatAddressPresentation(address, 'en', '').singleLine;
    expect(english).toContain('360 Xiaomuqiao Road');
    expect(english).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
