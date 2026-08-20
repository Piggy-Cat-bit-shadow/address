export interface HongKongRegion {
  id: number;
  code: 'HK' | 'KLN' | 'NT';
  name: string;
  native: string;
  zh: string;
}

export interface HongKongDistrict {
  id: number;
  code: string;
  regionCode: HongKongRegion['code'];
  name: string;
  native: string;
  zh: string;
  aliases?: readonly string[];
}

export declare const hongKongRegions: readonly HongKongRegion[];
export declare const hongKongDistricts: readonly HongKongDistrict[];
export declare const findHongKongRegion: (value: unknown) => HongKongRegion | undefined;
export declare const findHongKongDistrict: (value: unknown) => HongKongDistrict | undefined;
export declare const validateHongKongAdministrativeHierarchy: (
  admin1: unknown,
  locality: unknown
) => { valid: true } | { valid: false; reason: string };
