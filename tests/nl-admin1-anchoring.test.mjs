import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PostgresAddressImporter } from '../server/sync/postgres-address-importer.mjs';
import { CatalogReverseGeocoder } from '../server/sync/catalog-reverse-geocoder.mjs';

const directories = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const source = {
  id: 'fixture', adapter: 'overture', name: 'Fixture', homepageUrl: 'https://example.test',
  dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0', licenseName: 'CC0',
  licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
  attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms',
  shareAlike: false, redistributionAllowed: true, updateCadence: 'monthly'
};

const NL_PROVINCES = [
  ['DR', 'Drenthe', 'Drenthe', 52.9067922, 6.6368423],
  ['FL', 'Flevoland', 'Flevoland', 52.4484375, 5.4235397],
  ['FR', 'Friesland', 'Fryslân', 53.0923689, 5.777043],
  ['GE', 'Gelderland', 'Gelderland', 52.1014041, 5.9515701],
  ['GR', 'Groningen', 'Groningen', 53.2193835, 6.5665017],
  ['LI', 'Limburg', 'Limburg', 51.2015196, 5.9046302],
  ['NB', 'North Brabant', 'Noord-Brabant', 51.6017723, 5.4441391],
  ['NH', 'North Holland', 'Noord-Holland', 52.7212825, 4.820665],
  ['OV', 'Overijssel', 'Overijssel', 52.4254143, 6.4610611],
  ['UT', 'Utrecht', 'Utrecht', 52.0907374, 5.1214201],
  ['ZE', 'Zeeland', 'Zeeland', 51.4162975, 3.7028061],
  ['ZH', 'South Holland', 'Zuid-Holland', 51.9966792, 4.5597397]
];
const NL_PROVINCE_NATIVE_NAMES = new Set(NL_PROVINCES.map(([, , nativeName]) => nativeName));

const seedRegions = async (database, countryCode, regions, startId = 1) => {
  for (const [index, [code, name, nativeName, latitude, longitude]] of regions.entries()) {
    await database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,path,latitude,longitude)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(startId + index, countryCode, code, name, nativeName, '', 'province', name, latitude, longitude).run();
  }
};

const createImporter = (database) => new PostgresAddressImporter({
  database,
  normalizeRecord: normalizeSourceRecord,
  hash: (value) => createHash('sha256').update(value).digest('hex'),
  reverseGeocoder: (countryCode) => CatalogReverseGeocoder.load(database, countryCode),
  localizeRecords: async (records) => records.map((record) => ({
    ...record,
    localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
      components: record.components, formattedAddress: record.formattedAddress, source: 'fixture'
    }]))
  }))
});

const writeFixture = async (rows) => {
  const directory = resolve('.data-cache', 'nl-admin1-tests', randomUUID());
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, 'fixture.jsonl');
  await writeFile(file, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8');
  return file;
};

const nlRow = (id, city, postcode, longitude, latitude, overrides = {}) => ({
  id, country: 'NL', admin1: city, locality: city, postal_city: city, address_levels: [city],
  postcode, street: 'Ooststraat', number: String(10 + Math.abs(id.length)), longitude, latitude,
  property_type: 'residential', residential_building_id: `building-${id}`, residential_building_class: 'house',
  ...overrides
});

describe('NL admin1 catalog anchoring', () => {
  it('replaces a city name in admin1 with the coordinate-derived province', async () => {
    const database = openTestDatabase(':memory:');
    await seedRegions(database, 'NL', NL_PROVINCES);
    const file = await writeFixture([
      nlRow('nl-domburg', 'Domburg', '4357 HC', 3.4939287, 51.5564394),
      nlRow('nl-tilburg', 'Tilburg', '5038 AB', 5.0919143, 51.5605849),
      nlRow('nl-eersel', 'Eersel', '5521 EH', 5.3209138, 51.3611476)
    ]);
    const result = await createImporter(database).importShard({
      shard: { id: 'fixture-nl', countryCode: 'NL', source },
      discovery: { version: '2026-07-22.0', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'a'.repeat(64) },
      maxRecords: 10, perLocality: 5
    });
    expect(result).toMatchObject({ acceptedCount: 3, rejectedCount: 0 });
    const rows = (await database.prepare(`SELECT admin1,admin1_code,locality,coverage
      FROM address_pool WHERE country_code='NL' ORDER BY locality`).all()).results;
    expect(rows).toEqual([
      expect.objectContaining({ admin1: 'Zeeland', admin1_code: 'ZE', locality: 'Domburg', coverage: 'sync:NL:ze:domburg:residential' }),
      expect.objectContaining({ admin1: 'Noord-Brabant', admin1_code: 'NB', locality: 'Eersel' }),
      expect.objectContaining({ admin1: 'Noord-Brabant', admin1_code: 'NB', locality: 'Tilburg', coverage: 'sync:NL:nb:tilburg:residential' })
    ]);
    for (const row of rows) expect(NL_PROVINCE_NATIVE_NAMES.has(row.admin1)).toBe(true);
    database.close();
  });

  it('keeps a source admin1 that already matches a catalog province, ignoring punctuation and case', async () => {
    const database = openTestDatabase(':memory:');
    await seedRegions(database, 'NL', NL_PROVINCES);
    const file = await writeFixture([
      nlRow('nl-amsterdam', 'Amsterdam', '1012 AB', 4.9041, 52.3676, { admin1: 'Noord-Holland', address_levels: ['Noord-Holland', 'Amsterdam'] }),
      nlRow('nl-rotterdam', 'Rotterdam', '3011 AA', 4.47917, 51.9225, { admin1: 'zuid holland', address_levels: ['zuid holland', 'Rotterdam'] })
    ]);
    await createImporter(database).importShard({
      shard: { id: 'fixture-nl', countryCode: 'NL', source },
      discovery: { version: '2026-07-22.0', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'b'.repeat(64) },
      maxRecords: 10, perLocality: 5
    });
    const rows = (await database.prepare(`SELECT admin1,admin1_code,locality
      FROM address_pool WHERE country_code='NL' ORDER BY locality`).all()).results;
    // Matched source text is kept verbatim: no churn for already-correct records.
    expect(rows).toEqual([
      expect.objectContaining({ admin1: 'Noord-Holland', admin1_code: '', locality: 'Amsterdam' }),
      expect.objectContaining({ admin1: 'zuid holland', admin1_code: '', locality: 'Rotterdam' })
    ]);
    database.close();
  });

  it('drops a record whose admin1 is unknown and whose coordinates anchor to no catalog region', async () => {
    const database = openTestDatabase(':memory:');
    await seedRegions(database, 'NL', NL_PROVINCES);
    const file = await writeFixture([
      nlRow('nl-good', 'Domburg', '4357 HC', 3.4939287, 51.5564394),
      nlRow('nl-alien', 'Atlantis', '9999 ZZ', -100, -40)
    ]);
    const result = await createImporter(database).importShard({
      shard: { id: 'fixture-nl', countryCode: 'NL', source },
      discovery: { version: '2026-07-22.0', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'c'.repeat(64) },
      maxRecords: 10, perLocality: 5
    });
    expect(result).toMatchObject({
      acceptedCount: 1,
      rejectionReasons: expect.objectContaining({ invalid_administrative_hierarchy: 1 })
    });
    expect(await database.prepare("SELECT admin1 FROM address_pool WHERE country_code='NL'").first('admin1')).toBe('Zeeland');
    database.close();
  });

  it('passes NL records through unchanged when no catalog is available', async () => {
    const database = openTestDatabase(':memory:');
    const file = await writeFixture([nlRow('nl-nocat', 'Domburg', '4357 HC', 3.4939287, 51.5564394)]);
    await createImporter(database).importShard({
      shard: { id: 'fixture-nl', countryCode: 'NL', source },
      discovery: { version: '2026-07-22.0', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'd'.repeat(64) },
      maxRecords: 10, perLocality: 5
    });
    expect(await database.prepare("SELECT admin1 FROM address_pool WHERE country_code='NL'").first('admin1')).toBe('Domburg');
    database.close();
  });

  it('does not rewrite admin1 for countries outside the catalog-anchored set', async () => {
    const database = openTestDatabase(':memory:');
    await seedRegions(database, 'GB', [['ENG', 'England', 'England', 52.3555, -1.1743]]);
    const file = await writeFixture([{
      id: 'gb-1', country: 'GB', admin1: 'Someshire', locality: 'London', postal_city: 'London',
      postcode: 'NW1 6XE', street: 'Baker Street', number: '221', longitude: -0.1586, latitude: 51.5238,
      property_type: 'residential', residential_building_id: 'building-gb-1', residential_building_class: 'house'
    }]);
    await createImporter(database).importShard({
      shard: { id: 'fixture-gb', countryCode: 'GB', source },
      discovery: { version: '2026-07-22.0', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'e'.repeat(64) },
      maxRecords: 10, perLocality: 5
    });
    expect(await database.prepare("SELECT admin1 FROM address_pool WHERE country_code='GB'").first('admin1')).toBe('Someshire');
    database.close();
  });

  it('accepts anchored-country admin1 spellings that differ only by diacritics or JP suffixes', async () => {
    const database = openTestDatabase(':memory:');
    await seedRegions(database, 'CA', [['QC', 'Quebec', 'Quebec', 52.9399, -73.5491]], 100);
    await seedRegions(database, 'JP', [['13', 'Tōkyō', '東京', 35.6895, 139.6917]], 200);
    const importer = createImporter(database);
    const canada = await writeFixture([{
      id: 'ca-1', country: 'CA', admin1: 'Québec', locality: 'Montréal', postal_city: 'Montréal',
      postcode: 'H2Y 1C6', street: 'Rue Saint-Paul', number: '400', longitude: -73.5539, latitude: 45.5045,
      property_type: 'residential', residential_building_id: 'building-ca-1', residential_building_class: 'house'
    }]);
    await importer.importShard({
      shard: { id: 'fixture-ca', countryCode: 'CA', source },
      discovery: { version: '2026-07-22.0', dataUrl: source.dataUrl },
      materialized: { file: canada, format: 'overture-jsonl', checksum: 'f'.repeat(64) },
      maxRecords: 10, perLocality: 5
    });
    const japan = await writeFixture([{
      id: 'jp-1', country: 'JP', address_levels: ['東京都', '新宿区', '西新宿'], postal_city: '新宿区',
      postcode: '1600023', street: '西新宿二丁目', number: '8番1号', longitude: 139.6917, latitude: 35.6895,
      property_type: 'apartment', residential_building_id: 'building-jp-1', residential_building_class: 'apartments'
    }]);
    await importer.importShard({
      shard: { id: 'fixture-jp', countryCode: 'JP', source },
      discovery: { version: '2026-07-22.0', dataUrl: source.dataUrl },
      materialized: { file: japan, format: 'overture-jsonl', checksum: '9'.repeat(64) },
      maxRecords: 10, perLocality: 5
    });
    // Both records match their catalog region despite the accent / 都 suffix, so the
    // source spelling is preserved and nothing is re-derived or dropped.
    expect(await database.prepare("SELECT admin1 FROM address_pool WHERE country_code='CA'").first('admin1')).toBe('Québec');
    expect(await database.prepare("SELECT admin1 FROM address_pool WHERE country_code='JP'").first('admin1')).toBe('東京都');
    database.close();
  });
});
