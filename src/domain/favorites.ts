import { countryByCode } from './countries';
import type {
  AddressPresentation, CountryCode, CountryGroup, GeneratedBundle, GeneratedUnit, VerifiedAddress
} from './types';

export const FAVORITES_SCHEMA_VERSION = 1;
export const MAX_FAVORITES = 1000;

export interface FavoriteAddressSnapshot {
  address: VerifiedAddress;
  addressFormats: GeneratedBundle['addressFormats'];
  generatedUnit?: GeneratedUnit;
  googleMaps: GeneratedBundle['googleMaps'];
}

export interface FavoriteAddress {
  id: string;
  schemaVersion: typeof FAVORITES_SCHEMA_VERSION;
  addressId: string;
  countryCode: CountryCode;
  continent: CountryGroup;
  position: number;
  createdAt: string;
  updatedAt: string;
  snapshot: FavoriteAddressSnapshot;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const favoriteIdFor = (bundle: Pick<GeneratedBundle, 'address' | 'generatedUnit'>): string => {
  const unit = bundle.generatedUnit?.components;
  return [bundle.address.id, unit?.building, unit?.unit, unit?.room].map((value) => text(value)).filter(Boolean).join(':');
};

export const favoriteFromBundle = (bundle: GeneratedBundle, position: number, now = new Date()): FavoriteAddress => {
  const country = countryByCode.get(bundle.address.countryCode);
  if (!country) throw new Error('INVALID_FAVORITE_COUNTRY');
  const timestamp = now.toISOString();
  return {
    id: favoriteIdFor(bundle), schemaVersion: FAVORITES_SCHEMA_VERSION, addressId: bundle.address.id,
    countryCode: bundle.address.countryCode, continent: country.group, position,
    createdAt: timestamp, updatedAt: timestamp,
    snapshot: {
      address: structuredClone(bundle.address), addressFormats: structuredClone(bundle.addressFormats),
      ...(bundle.generatedUnit ? { generatedUnit: structuredClone(bundle.generatedUnit) } : {}),
      googleMaps: structuredClone(bundle.googleMaps)
    }
  };
};

export const isFavoriteAddress = (value: unknown): value is FavoriteAddress => {
  if (!value || typeof value !== 'object') return false;
  const favorite = value as Partial<FavoriteAddress>;
  const country = text(favorite.countryCode);
  const snapshot = favorite.snapshot as Partial<FavoriteAddressSnapshot> | undefined;
  return favorite.schemaVersion === FAVORITES_SCHEMA_VERSION
    && Boolean(text(favorite.id) && text(favorite.addressId) && countryByCode.has(country as CountryCode))
    && Number.isInteger(favorite.position) && Number(favorite.position) > 0
    && Boolean(snapshot?.address && snapshot.address.countryCode === country && snapshot.address.id === favorite.addressId)
    && Boolean(snapshot?.addressFormats?.native?.singleLine && snapshot?.googleMaps);
};

export const normalizedFavoritePositions = (values: readonly FavoriteAddress[]): FavoriteAddress[] => {
  const grouped = new Map<CountryCode, FavoriteAddress[]>();
  for (const value of values) grouped.set(value.countryCode, [...(grouped.get(value.countryCode) || []), value]);
  return [...grouped.values()].flatMap((entries) => entries
    .sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt))
    .map((entry, index) => ({ ...entry, position: index + 1 })));
};

export const moveFavoriteWithinCountry = (
  values: readonly FavoriteAddress[], id: string, requestedPosition: number
): FavoriteAddress[] => {
  const source = values.find((value) => value.id === id);
  if (!source) return [...values];
  const countryEntries = values.filter((value) => value.countryCode === source.countryCode)
    .sort((left, right) => left.position - right.position);
  const currentIndex = countryEntries.findIndex((value) => value.id === id);
  const targetIndex = Math.max(0, Math.min(countryEntries.length - 1, Math.trunc(requestedPosition) - 1));
  const [moved] = countryEntries.splice(currentIndex, 1);
  countryEntries.splice(targetIndex, 0, moved);
  const positions = new Map(countryEntries.map((value, index) => [value.id, index + 1]));
  return values.map((value) => positions.has(value.id) ? { ...value, position: positions.get(value.id)! } : value);
};

export const safeExternalUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

export type FavoriteAddressPresentationSource = {
  address: VerifiedAddress;
  addressFormats: Record<'native' | 'en' | 'zh-CN', AddressPresentation>;
};
