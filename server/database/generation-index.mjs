import { addressQualitySqlClause } from '../../src/domain/address-quality.mjs';

const nativeSemanticFields = ['street', 'locality', 'postalLocality', 'district', 'dependentLocality', 'admin1', 'buildingName'];
const localizedHanClause = (prefix = '') => `(${nativeSemanticFields
  .map((field) => `(${prefix}component_variants_json::jsonb -> 'zh-CN' ->> '${field}') ~ '[一-龥]'`)
  .join(' OR ')})`;

const publishableClause = (prefix = '') => [
  `${prefix}quality_score >= 0.7`,
  addressQualitySqlClause(prefix),
  localizedHanClause(prefix)
].join(' AND ');

export const generationIndexRowCount = async (database) => Number(
  await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total') || 0
);

export const refreshAddressGenerationIndex = async (database, countryCode) => {
  const scope = String(countryCode || '').trim().toUpperCase();
  if (!scope) return 0;
  const updatedAt = new Date().toISOString();
  const source = 'address_pool_runtime runtime';
  const eligible = publishableClause('runtime.');
  await database.prepare('UPDATE address_generation_index SET active=0 WHERE country_code=?').bind(scope).run();
  await database.prepare(`
    INSERT INTO address_generation_index(
      address_id,country_code,admin1_key,admin1_code_key,locality_key,postal_locality_key,
      district_key,postcode_key,locality,postal_locality,district,postcode,street,house_number,
      building_name,search_text,random_key,residential_ready,active,source_revision,updated_at
    ) SELECT runtime.id,runtime.country_code,runtime.admin1_key,runtime.admin1_code_key,
      runtime.locality_key,runtime.postal_locality_key,runtime.district_key,runtime.postcode_key,
      runtime.locality,runtime.postal_locality,runtime.district,runtime.postcode,runtime.street,
      runtime.house_number,runtime.building_name,
      lower(concat_ws(' ',runtime.house_number,runtime.street,runtime.building_name,runtime.district,
        runtime.locality,runtime.postal_locality,runtime.admin1,runtime.admin1_code,runtime.postcode)),
      runtime.random_key,
      CASE WHEN runtime.property_type IN ('residential','apartment') AND runtime.residential_evidence=1 THEN 1 ELSE 0 END,
      1,concat_ws(':',runtime.dataset_id,runtime.dataset_version),?
    FROM ${source}
    WHERE runtime.country_code=? AND runtime.active=1 AND ${eligible}
    ON CONFLICT(address_id) DO UPDATE SET
      country_code=excluded.country_code,admin1_key=excluded.admin1_key,admin1_code_key=excluded.admin1_code_key,
      locality_key=excluded.locality_key,postal_locality_key=excluded.postal_locality_key,
      district_key=excluded.district_key,postcode_key=excluded.postcode_key,locality=excluded.locality,
      postal_locality=excluded.postal_locality,district=excluded.district,postcode=excluded.postcode,
      street=excluded.street,house_number=excluded.house_number,building_name=excluded.building_name,
      search_text=excluded.search_text,random_key=excluded.random_key,residential_ready=excluded.residential_ready,
      active=1,source_revision=excluded.source_revision,updated_at=excluded.updated_at
  `).bind(updatedAt, scope).run();
  return generationIndexRowCountForCountry(database, scope);
};

const generationIndexRowCountForCountry = async (database, countryCode) => Number(
  await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE country_code=? AND active=1')
    .bind(countryCode).first('total') || 0
);

export const refreshAddressGenerationIndexIfEmpty = async (database, countryCodes) => {
  if (await generationIndexRowCount(database)) return false;
  for (const countryCode of countryCodes) await refreshAddressGenerationIndex(database, countryCode);
  return true;
};
