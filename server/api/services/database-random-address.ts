import type { Database } from '../../database/database.mjs';
import type { CountryCode, VerifiedAddress } from '../../../src/domain/types';
import { matchesCustomBlacklist } from '../../lib/custom-blacklist.mjs';
import {
  chinaCommunityPublicationClause, loadChinaCommunityAddressById
} from '../repositories/china-community';
import {
  chineseVariantHasHanClause, completenessClause, loadAddressPoolV2AddressById
} from '../repositories/address-pool-v2';
import {
  RandomAddressIndex, type RandomAddressIndexRow, type RandomAddressReference
} from './random-address-index';
import type {
  RandomAddressPick, RandomAddressPickInput, RandomAddressPickState, RandomAddressService
} from './random-address-service';

interface PoolMetadataRow {
  id: string;
  country_code: CountryCode;
  admin1: string;
  admin1_code: string;
  locality: string;
  postal_locality: string;
  district: string;
  postcode: string;
  street: string;
  house_number: string;
  building_name: string;
}

interface CommunityMetadataRow {
  id: string;
  province: string;
  city: string;
  district: string;
  township: string;
  provider_address: string;
  canonical_name: string;
}

const mapConcurrent = async <T, R>(values: T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index]);
    }
  }));
  return results;
};

export const loadRandomAddressIndexRows = async (
  db: Database,
  countries: CountryCode[],
  concurrency = 4
): Promise<RandomAddressIndexRow[]> => {
  const selected = countries.filter((country) => country !== 'CN');
  const poolRows = (await mapConcurrent(selected, Math.max(1, concurrency), async (country) =>
    (await db.prepare(`SELECT id,country_code,admin1,admin1_code,locality,postal_locality,
      district,postcode,street,house_number,building_name FROM address_pool_runtime
    WHERE country_code=? AND quality_score>=0.7
      AND property_type IN ('residential','apartment') AND residential_evidence=1
      AND ${completenessClause()}
      AND ${chineseVariantHasHanClause()}
    ORDER BY id`).bind(country).all<PoolMetadataRow>()).results
  )).flat();
  const communityRows = countries.includes('CN') ? (await db.prepare(`SELECT community.id,community.province,
      community.city,community.district,community.township,community.provider_address,community.canonical_name
    FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')}
    ORDER BY community.id`).all<CommunityMetadataRow>()).results : [];
  return [
    ...poolRows.map((row) => ({
      addressId: row.id,
      countryCode: row.country_code,
      source: 'address-pool-v2' as const,
      regionValues: [row.admin1, row.admin1_code],
      cityValues: [row.locality, row.postal_locality],
      districtValues: [row.district],
      postcodeValues: [row.postcode],
      searchText: [row.house_number, row.street, row.building_name, row.district, row.locality,
        row.postal_locality, row.admin1, row.admin1_code, row.postcode].filter(Boolean).join(' ')
    })),
    ...communityRows.filter((row) => !matchesCustomBlacklist([
      row.canonical_name, row.provider_address, row.province, row.city, row.district, row.township
    ])).map((row) => ({
      addressId: row.id,
      countryCode: 'CN' as const,
      source: 'china-map-community' as const,
      regionValues: [row.province],
      cityValues: [row.city],
      districtValues: [row.district],
      postcodeValues: [],
      searchText: [row.province, row.city, row.district, row.township,
        row.provider_address, row.canonical_name].filter(Boolean).join(' ')
    }))
  ];
};

export const loadRandomAddressVersionToken = async (db: Database): Promise<string> => {
  const row = await db.prepare(`SELECT
    COALESCE((SELECT MAX(last_seen_at) FROM address_pool),'') AS address_version,
    COALESCE((SELECT MAX(updated_at) FROM cn_communities_v2),'') AS china_version,
    COALESCE((SELECT version FROM address_pool_revisions WHERE kind='translation'),'') AS translation_version`)
    .first<{ address_version: string; china_version: string; translation_version: string }>();
  return `${row?.address_version || ''}:${row?.china_version || ''}:${row?.translation_version || ''}`;
};

const loadAddress = async (
  db: Database,
  reference: RandomAddressReference
): Promise<VerifiedAddress | undefined> => reference.source === 'china-map-community'
  ? loadChinaCommunityAddressById(db, `cn-community-${reference.addressId}`)
  : loadAddressPoolV2AddressById(db, `pool-v2-${reference.addressId}`);

export class DatabaseRandomAddressService implements RandomAddressService {
  private index?: RandomAddressIndex;
  private refreshTimer?: NodeJS.Timeout;
  private refreshToken = '';
  private refreshing?: Promise<void>;

  constructor(
    private readonly database: Database,
    private readonly countries: CountryCode[],
    private readonly refreshIntervalMs = 60_000
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => void this.refreshIfChanged(), Math.max(10_000, this.refreshIntervalMs));
    this.refreshTimer.unref();
  }

  async pick(input: RandomAddressPickInput): Promise<RandomAddressPickState> {
    const index = this.index;
    if (!index) return { ready: false };
    const candidates = index.candidates(input.countryCode, input.filters, input.target);
    const tried = new Set<string>();
    for (let attempt = 0; attempt < Math.min(32, candidates.length); attempt += 1) {
      const selection = index.select(input.countryCode, input.filters, input.target, input.seed, attempt);
      if (!selection) break;
      const key = `${selection.reference.source}:${selection.reference.addressId}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const address = await loadAddress(this.database, selection.reference);
      if (address) {
        const result: RandomAddressPick = {
          address, source: selection.reference.source, eligibleCount: selection.candidateCount
        };
        return { ready: true, result };
      }
    }
    return { ready: true };
  }

  async close(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.refreshing;
  }

  private async token(): Promise<string> {
    return loadRandomAddressVersionToken(this.database);
  }

  private async refresh(): Promise<void> {
    const rows = await loadRandomAddressIndexRows(this.database, this.countries);
    const next = new RandomAddressIndex(rows);
    this.refreshToken = await this.token();
    this.index = next;
  }

  private async refreshIfChanged(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (await this.token() !== this.refreshToken) await this.refresh();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
}
