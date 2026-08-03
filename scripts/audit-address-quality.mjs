import { openPostgresDatabase } from '../server/database/postgres.mjs';
import { validateAddressQuality } from '../src/domain/address-quality.mjs';

const database = await openPostgresDatabase({ migrate: false });
const results = {};
let cursor = '';

try {
  while (true) {
    const rows = (await database.prepare(`SELECT id,country_code,admin1,admin1_code,locality,postal_locality,
      district,postcode,street,house_number,building_name,component_variants_json
      FROM address_pool WHERE active=1 AND id>? ORDER BY id LIMIT 5000`).bind(cursor).all()).results;
    if (!rows.length) break;
    for (const row of rows) {
      cursor = String(row.id);
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
  console.log(JSON.stringify({ database: 'postgres', countries: results }, null, 2));
} finally {
  await database.close();
}
