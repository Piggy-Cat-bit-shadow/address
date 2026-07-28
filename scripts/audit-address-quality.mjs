import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../server/database/sqlite.mjs';
import { validateAddressQuality } from '../src/domain/address-quality.mjs';

const databasePath = resolve(process.env.ADDRESS_DATABASE_PATH || 'data/address.sqlite');
await access(databasePath);
const database = openDatabase(databasePath, { readOnly: true });
const results = {};
let cursor = 0;

try {
  while (true) {
    const rows = (await database.prepare(`SELECT rowid AS rid,country_code,admin1,admin1_code,locality,postal_locality,
      district,postcode,street,house_number,building_name,component_variants_json
      FROM address_pool WHERE active=1 AND rowid>? ORDER BY rowid LIMIT 5000`).bind(cursor).all()).results;
    if (!rows.length) break;
    for (const row of rows) {
      cursor = Number(row.rid);
      let sourceComponents = {};
      try { sourceComponents = JSON.parse(String(row.component_variants_json || '{}')).native || {}; } catch {}
      const components = {
        houseNumber: row.house_number,
        street: row.street,
        buildingName: row.building_name,
        locality: row.locality,
        postalLocality: row.postal_locality,
        district: row.district,
        dependentLocality: row.district,
        admin1: row.admin1,
        admin1Code: row.admin1_code,
        postcode: row.postcode,
        ...sourceComponents
      };
      const quality = validateAddressQuality({ countryCode: row.country_code, components });
      const country = results[row.country_code] ||= { total: 0, accepted: 0, rejected: 0, reasons: {} };
      country.total += 1;
      if (quality.valid) country.accepted += 1;
      else {
        country.rejected += 1;
        for (const reason of quality.reasons) country.reasons[reason] = (country.reasons[reason] || 0) + 1;
      }
    }
  }
  console.log(JSON.stringify({ database: databasePath, countries: results }, null, 2));
} finally {
  database.close();
}
