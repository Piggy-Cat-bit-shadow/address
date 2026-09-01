import { readFile } from 'node:fs/promises';
import { openPostgresDatabase } from '../server/database/postgres.mjs';

const db = await openPostgresDatabase({ migrate: false });
const manifest = JSON.parse(await readFile(new URL('../src/domain/location-catalog.meta.json', import.meta.url), 'utf8'));
const scalar = async (sql, ...params) => Number(await db.prepare(sql).bind(...params).first('value') || 0);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  for (const [table, expected] of Object.entries({
    catalog_regions: manifest.totals.regions,
    catalog_cities: manifest.totals.cities,
    catalog_postcodes: manifest.totals.postcodes
  })) {
    assert(await scalar(`SELECT COUNT(*) AS value FROM ${table}`) === expected, `${table} count mismatch`);
  }

  assert(await scalar(`SELECT COUNT(*) AS value FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id=c.region_id
    WHERE c.region_id IS NOT NULL AND (r.id IS NULL OR r.country_code<>c.country_code)`) === 0, 'orphan or cross-country cities found');
  assert(await scalar(`SELECT COUNT(*) AS value FROM catalog_postcodes p LEFT JOIN catalog_regions r ON r.id=p.region_id
    WHERE p.region_id IS NOT NULL AND (r.id IS NULL OR r.country_code<>p.country_code)`) === 0, 'orphan or cross-country postcodes found');
  assert(await scalar(`SELECT COUNT(*) AS value FROM catalog_postcodes p LEFT JOIN catalog_cities c ON c.id=p.city_id
    WHERE p.city_id IS NOT NULL AND (c.id IS NULL OR c.country_code<>p.country_code)`) === 0, 'orphan or cross-country postcode cities found');

  for (const [country, expected] of Object.entries(manifest.countries)) {
    const regions = await scalar('SELECT COUNT(*) AS value FROM catalog_regions WHERE country_code=?', country);
    const cities = await scalar('SELECT COUNT(*) AS value FROM catalog_cities WHERE country_code=?', country);
    const postcodes = await scalar('SELECT COUNT(*) AS value FROM catalog_postcodes WHERE country_code=?', country);
    assert(regions === expected.regions && cities === expected.cities && postcodes === expected.postcodes, `${country} manifest mismatch`);
    assert(regions > 0, `${country} has no regions`);
    assert(cities > 0, `${country} has no cities`);
  }

  const citiesWithin = async (country, regionName) => (await db.prepare(`SELECT c.name FROM catalog_cities c
    JOIN catalog_regions selected ON selected.country_code=c.country_code AND selected.name=?
    JOIN catalog_regions child ON child.id=c.region_id AND child.path LIKE selected.path||'%'
    WHERE c.country_code=?`).bind(regionName, country).all()).results.map((row) => row.name);
  const california = await citiesWithin('US', 'California');
  assert(california.includes('Los Angeles'), 'California is missing Los Angeles');
  assert(!california.includes('Chicago'), 'California contains Chicago');
  const guangdong = await citiesWithin('CN', 'Guangdong');
  assert(guangdong.some((name) => /Shenzhen/i.test(name)), 'Guangdong is missing Shenzhen');
  assert(!guangdong.some((name) => /Beijing/i.test(name)), 'Guangdong contains Beijing');

  const summary = {};
  for (const country of Object.keys(manifest.countries)) {
    summary[country] = {
      regions: await scalar('SELECT COUNT(*) AS value FROM catalog_regions WHERE country_code=?', country),
      cities: await scalar('SELECT COUNT(*) AS value FROM catalog_cities WHERE country_code=?', country),
      postcodes: await scalar('SELECT COUNT(DISTINCT code) AS value FROM catalog_postcodes WHERE country_code=?', country)
    };
  }
  console.log(JSON.stringify({ totals: manifest.totals, countries: summary }, null, 2));
} finally {
  await db.close();
}
