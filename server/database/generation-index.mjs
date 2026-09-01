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
      building_name,search_text,random_key,country_rank,residential_rank,residential_ready,active,source_revision,updated_at
    ) SELECT ranked.id,ranked.country_code,ranked.admin1_key,ranked.admin1_code_key,
      ranked.locality_key,ranked.postal_locality_key,ranked.district_key,ranked.postcode_key,
      ranked.locality,ranked.postal_locality,ranked.district,ranked.postcode,ranked.street,
      ranked.house_number,ranked.building_name,
      lower(concat_ws(' ',ranked.house_number,ranked.street,ranked.building_name,ranked.district,
        ranked.locality,ranked.postal_locality,ranked.admin1,ranked.admin1_code,ranked.postcode)),
      ranked.random_key,ranked.country_rank,ranked.residential_rank,ranked.ready,
      1,concat_ws(':',ranked.dataset_id,ranked.dataset_version),?
    FROM (
      SELECT eligible_runtime.*,
        ROW_NUMBER() OVER (ORDER BY random_key,id) AS country_rank,
        CASE WHEN ready=1 THEN ROW_NUMBER() OVER (PARTITION BY ready ORDER BY random_key,id) END AS residential_rank
      FROM (
        SELECT runtime.*,
          CASE WHEN runtime.property_type IN ('residential','apartment') AND runtime.residential_evidence=1 THEN 1 ELSE 0 END AS ready
        FROM ${source}
        WHERE runtime.country_code=? AND runtime.active=1 AND ${eligible}
      ) eligible_runtime
    ) ranked
    ON CONFLICT(address_id) DO UPDATE SET
      country_code=excluded.country_code,admin1_key=excluded.admin1_key,admin1_code_key=excluded.admin1_code_key,
      locality_key=excluded.locality_key,postal_locality_key=excluded.postal_locality_key,
      district_key=excluded.district_key,postcode_key=excluded.postcode_key,locality=excluded.locality,
      postal_locality=excluded.postal_locality,district=excluded.district,postcode=excluded.postcode,
      street=excluded.street,house_number=excluded.house_number,building_name=excluded.building_name,
      search_text=excluded.search_text,random_key=excluded.random_key,country_rank=excluded.country_rank,
      residential_rank=excluded.residential_rank,residential_ready=excluded.residential_ready,
      active=1,source_revision=excluded.source_revision,updated_at=excluded.updated_at
  `).bind(updatedAt, scope).run();
  return generationIndexRowCountForCountry(database, scope);
};

export const refreshStaleAddressGenerationIndexes = async (database) => {
  const eligible = publishableClause('runtime.');
  const rows = (await database.prepare(`WITH source_counts AS (
      SELECT runtime.country_code,COUNT(*) AS source_count
      FROM address_pool_runtime runtime
      WHERE runtime.active=1 AND ${eligible}
      GROUP BY runtime.country_code
    ), index_counts AS (
      SELECT country_code,COUNT(*) FILTER (WHERE active=1) AS index_count,
        COUNT(*) FILTER (WHERE active=1 AND country_rank IS NULL) AS missing_ranks
      FROM address_generation_index GROUP BY country_code
    )
    SELECT source_counts.country_code
    FROM source_counts LEFT JOIN index_counts USING(country_code)
    WHERE source_counts.source_count<>COALESCE(index_counts.index_count,0)
      OR COALESCE(index_counts.missing_ranks,0)>0
    ORDER BY source_counts.country_code`).all()).results || [];
  for (const { country_code: countryCode } of rows) await refreshAddressGenerationIndex(database, countryCode);
  return rows.map(({ country_code: countryCode }) => countryCode);
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
