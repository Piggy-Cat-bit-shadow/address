export const hongKongRegions = Object.freeze([
  { id: 344_001_001, code: 'HK', name: 'Hong Kong Island', native: '香港島', zh: '香港岛' },
  { id: 344_001_002, code: 'KLN', name: 'Kowloon', native: '九龍', zh: '九龙' },
  { id: 344_001_003, code: 'NT', name: 'New Territories', native: '新界', zh: '新界' }
]);

export const hongKongDistricts = Object.freeze([
  { id: 344_002_001, code: 'CW', regionCode: 'HK', name: 'Central and Western', native: '中西區', zh: '中西区', aliases: ['Central & Western'] },
  { id: 344_002_002, code: 'EST', regionCode: 'HK', name: 'Eastern', native: '東區', zh: '东区' },
  { id: 344_002_003, code: 'STH', regionCode: 'HK', name: 'Southern', native: '南區', zh: '南区' },
  { id: 344_002_004, code: 'WC', regionCode: 'HK', name: 'Wan Chai', native: '灣仔區', zh: '湾仔区' },
  { id: 344_002_005, code: 'KLC', regionCode: 'KLN', name: 'Kowloon City', native: '九龍城區', zh: '九龙城区' },
  { id: 344_002_006, code: 'KT', regionCode: 'KLN', name: 'Kwun Tong', native: '觀塘區', zh: '观塘区' },
  { id: 344_002_007, code: 'SSP', regionCode: 'KLN', name: 'Sham Shui Po', native: '深水埗區', zh: '深水埗区' },
  { id: 344_002_008, code: 'WTS', regionCode: 'KLN', name: 'Wong Tai Sin', native: '黃大仙區', zh: '黄大仙区' },
  { id: 344_002_009, code: 'YTM', regionCode: 'KLN', name: 'Yau Tsim Mong', native: '油尖旺區', zh: '油尖旺区' },
  { id: 344_002_010, code: 'ILD', regionCode: 'NT', name: 'Islands', native: '離島區', zh: '离岛区' },
  { id: 344_002_011, code: 'KC', regionCode: 'NT', name: 'Kwai Tsing', native: '葵青區', zh: '葵青区' },
  { id: 344_002_012, code: 'NTH', regionCode: 'NT', name: 'North', native: '北區', zh: '北区' },
  { id: 344_002_013, code: 'SK', regionCode: 'NT', name: 'Sai Kung', native: '西貢區', zh: '西贡区' },
  { id: 344_002_014, code: 'ST', regionCode: 'NT', name: 'Sha Tin', native: '沙田區', zh: '沙田区' },
  { id: 344_002_015, code: 'TP', regionCode: 'NT', name: 'Tai Po', native: '大埔區', zh: '大埔区' },
  { id: 344_002_016, code: 'TW', regionCode: 'NT', name: 'Tsuen Wan', native: '荃灣區', zh: '荃湾区' },
  { id: 344_002_017, code: 'TM', regionCode: 'NT', name: 'Tuen Mun', native: '屯門區', zh: '屯门区' },
  { id: 344_002_018, code: 'YL', regionCode: 'NT', name: 'Yuen Long', native: '元朗區', zh: '元朗区' }
]);

const normalized = (value = '') => String(value)
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/&/gu, 'and')
  .replace(/district|region/gu, '')
  .replace(/[區区]/gu, '')
  .replace(/[島岛]/gu, '島')
  .replace(/[龍龙]/gu, '龍')
  .replace(/[灣湾]/gu, '灣')
  .replace(/[東东]/gu, '東')
  .replace(/[貢贡]/gu, '貢')
  .replace(/[離离]/gu, '離')
  .replace(/[門门]/gu, '門')
  .replace(/[黃黄]/gu, '黃')
  .replace(/[^\p{L}\p{N}]+/gu, '');

const regionAliases = new Map();
for (const region of hongKongRegions) {
  for (const value of [region.code, region.name, region.native, region.zh]) regionAliases.set(normalized(value), region);
}
regionAliases.set(normalized('Hong Kong'), hongKongRegions[0]);

const districtAliases = new Map();
for (const district of hongKongDistricts) {
  for (const value of [district.code, district.name, district.native, district.zh, ...(district.aliases || [])]) {
    districtAliases.set(normalized(value), district);
  }
}

export const findHongKongRegion = (value) => regionAliases.get(normalized(value));
export const findHongKongDistrict = (value) => districtAliases.get(normalized(value));

export const validateHongKongAdministrativeHierarchy = (admin1, locality) => {
  const region = findHongKongRegion(admin1);
  if (!region) return { valid: false, reason: 'invalid-hk-region' };
  const district = findHongKongDistrict(locality);
  if (!district) return { valid: false, reason: 'invalid-hk-district' };
  if (district.regionCode !== region.code) return { valid: false, reason: 'mismatched-hk-hierarchy' };
  return { valid: true };
};
