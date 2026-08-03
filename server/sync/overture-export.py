import argparse
import json
import math
import pathlib
import sys

import duckdb


def sql_string(value):
    return "'" + value.replace("'", "''") + "'"


def parquet_input(values):
    if len(values) == 1:
        return sql_string(values[0])
    return "[" + ",".join(sql_string(value) for value in values) + "]"


parser = argparse.ArgumentParser()
parser.add_argument("--country", required=True)
parser.add_argument("--release", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--max-records", type=int, required=True)
parser.add_argument("--per-locality", type=int, required=True)
parser.add_argument("--assets-file", required=True)
parser.add_argument("--building-assets-file", required=True)
parser.add_argument("--bounds", type=float, nargs=4, required=True)
parser.add_argument("--candidate-jsonl")
args = parser.parse_args()

if not args.country.isalpha() or len(args.country) != 2:
    raise ValueError("country must be an ISO alpha-2 code")
if args.max_records < 1 or args.per_locality < 1:
    raise ValueError("record limits must be positive")

assets = json.loads(pathlib.Path(args.assets_file).read_text(encoding="utf-8"))
if (not isinstance(assets, list)
        or (not args.candidate_jsonl and not assets)
        or not all(isinstance(value, str) and value.startswith("https://") for value in assets)):
    raise ValueError("assets-file must contain HTTPS GeoParquet URLs")
building_asset_values = json.loads(pathlib.Path(args.building_assets_file).read_text(encoding="utf-8"))
if not isinstance(building_asset_values, list):
    raise ValueError("building-assets-file must contain HTTPS GeoParquet URLs")
building_asset_entries = []
for value in building_asset_values:
    if isinstance(value, str) and value.startswith("https://"):
        building_asset_entries.append({"url": value, "bbox": None})
    elif (isinstance(value, dict) and isinstance(value.get("url"), str)
          and value["url"].startswith("https://") and isinstance(value.get("bbox"), list)
          and len(value["bbox"]) >= 4):
        building_asset_entries.append({"url": value["url"], "bbox": value["bbox"][:4]})
    else:
        raise ValueError("building-assets-file must contain HTTPS GeoParquet URLs with optional bboxes")
building_assets = [entry["url"] for entry in building_asset_entries]

connection = duckdb.connect()
connection.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")
connection.execute("SET preserve_insertion_order=false")
connection.execute("SET threads=4")
connection.execute("SET enable_http_metadata_cache=true")
connection.execute("SET http_keep_alive=true")
connection.execute("SET http_retries=10")
connection.execute("SET http_retry_wait_ms=250")
connection.execute("SET http_timeout=120")
temporary_directory = pathlib.Path(args.output).resolve().parent / "duckdb-temp"
temporary_directory.mkdir(parents=True, exist_ok=True)
connection.execute("SET memory_limit='2GB'")
connection.execute(f"SET temp_directory={sql_string(str(temporary_directory))}")
output = sql_string(str(pathlib.Path(args.output).resolve()))
country = sql_string(args.country.upper())
minimum_longitude, minimum_latitude, maximum_longitude, maximum_latitude = args.bounds
if not (-180 <= minimum_longitude < maximum_longitude <= 180
        and -90 <= minimum_latitude < maximum_latitude <= 90):
    raise ValueError("bounds must be a valid minLon minLat maxLon maxLat box")
candidate_multiplier = 12 if args.candidate_jsonl else 4
candidate_limit = min(max(args.max_records, args.max_records * candidate_multiplier), 250000)
residential_grid_scale = 4

if args.candidate_jsonl:
    candidate_file = pathlib.Path(args.candidate_jsonl).resolve()
    if not candidate_file.is_file():
        raise ValueError("candidate-jsonl must be an existing file")
    candidate_query = f"""
CREATE TEMP TABLE address_candidates AS
  SELECT
    0 AS priority,
    id, country, admin1, locality, postal_city, district,
    address_levels, postcode, street, number, unit,
    longitude, latitude, source_dataset, source_record_id,
    ST_Point(longitude, latitude) AS geometry
  FROM read_json_auto({sql_string(str(candidate_file))}, format='newline_delimited')
  WHERE country = {country}
    AND longitude BETWEEN {minimum_longitude} AND {maximum_longitude}
    AND latitude BETWEEN {minimum_latitude} AND {maximum_latitude}
  LIMIT {candidate_limit};
"""
else:
    per_asset_limit = max(1, math.ceil(candidate_limit / len(assets)))
    asset_queries = []
    for asset in assets:
        asset_queries.append(f"""
    SELECT * FROM (
    SELECT
      id,
      country,
      coalesce(address_levels[1].value, '') AS admin1,
      coalesce(
        nullif(trim(postal_city), ''),
        CASE WHEN len(address_levels) >= 3 THEN address_levels[-2].value ELSE address_levels[-1].value END,
        ''
      ) AS locality,
      coalesce(postal_city, '') AS postal_city,
      coalesce(address_levels[-1].value, '') AS district,
      list_transform(address_levels, address_level -> coalesce(address_level.value, '')) AS address_levels,
      coalesce(postcode, '') AS postcode,
      street,
      number,
      coalesce(unit, '') AS unit,
      ST_X(geometry) AS longitude,
      ST_Y(geometry) AS latitude,
      coalesce(sources[1].dataset, 'Overture Maps addresses') AS source_dataset,
      coalesce(sources[1].record_id, id) AS source_record_id,
      geometry
    FROM read_parquet({sql_string(asset)}, union_by_name=true)
    WHERE country = {country}
      AND bbox.xmin >= {minimum_longitude}
      AND bbox.xmax <= {maximum_longitude}
      AND bbox.ymin >= {minimum_latitude}
      AND bbox.ymax <= {maximum_latitude}
      AND nullif(trim(street), '') IS NOT NULL
      AND nullif(trim(number), '') IS NOT NULL
      AND geometry IS NOT NULL
    LIMIT {per_asset_limit}
    )
""")
    candidate_sources = "\nUNION ALL\n".join(asset_queries)
    candidate_query = f"""
CREATE TEMP TABLE address_candidates AS
  WITH source AS (
{candidate_sources}
  )
  SELECT 0 AS priority, *
  FROM source
  LIMIT {candidate_limit};
"""
connection.execute(candidate_query)

residential_grids = []
if building_assets:
    connection.execute(f"""
CREATE TEMP TABLE residential_grids AS
SELECT
  CAST(greatest(-720, least(719, floor(longitude * {residential_grid_scale}))) AS INTEGER) AS grid_longitude,
  CAST(greatest(-360, least(359, floor(latitude * {residential_grid_scale}))) AS INTEGER) AS grid_latitude,
  count(*) AS address_count
FROM address_candidates
GROUP BY grid_longitude, grid_latitude
ORDER BY address_count DESC, grid_latitude, grid_longitude;
""")
    residential_grids = connection.execute("""
SELECT grid_longitude, grid_latitude, address_count
FROM residential_grids
ORDER BY address_count DESC, grid_latitude, grid_longitude;
""").fetchall()

fallback_query = f"""
COPY (
  SELECT * EXCLUDE (priority, geometry), 'unknown' AS property_type,
    '' AS residential_building_id, '' AS residential_building_class
  FROM address_candidates
  LIMIT {args.max_records}
) TO {output} (FORMAT JSON, ARRAY false);
"""

selected_building_assets = [
    entry["url"] for entry in building_asset_entries
    if entry["bbox"] is None or any(
        entry["bbox"][2] >= grid_longitude / residential_grid_scale
        and entry["bbox"][0] < (grid_longitude + 1) / residential_grid_scale
        and entry["bbox"][3] >= grid_latitude / residential_grid_scale
        and entry["bbox"][1] < (grid_latitude + 1) / residential_grid_scale
        for grid_longitude, grid_latitude, _ in residential_grids
    )
]

if not selected_building_assets or not residential_grids:
    connection.execute(fallback_query)
else:
    building_asset_list = parquet_input(selected_building_assets)
    residential_classes = "(" + ",".join(sql_string(value) for value in (
        "allotment_house", "apartments", "bungalow", "cabin", "detached", "dormitory",
        "dwelling_house", "ger", "house", "houseboat", "residential", "semi",
        "semidetached_house", "static_caravan", "stilt_house", "terrace", "trullo"
    )) + ")"
    classified_query = f"""
COPY (
  WITH residential_buildings AS (
    SELECT DISTINCT buildings.id, buildings.class, buildings.geometry
    FROM read_parquet({building_asset_list}, union_by_name=true) AS buildings
    JOIN residential_grids ON
      buildings.bbox.xmax >= residential_grids.grid_longitude / {residential_grid_scale}
      AND buildings.bbox.xmin < (residential_grids.grid_longitude + 1) / {residential_grid_scale}
      AND buildings.bbox.ymax >= residential_grids.grid_latitude / {residential_grid_scale}
      AND buildings.bbox.ymin < (residential_grids.grid_latitude + 1) / {residential_grid_scale}
    WHERE buildings.class IN {residential_classes}
      AND buildings.geometry IS NOT NULL
  ), matches AS (
    SELECT
      address_candidates.id AS address_id,
      residential_buildings.id AS building_id,
      residential_buildings.class AS building_class,
      row_number() OVER (
        PARTITION BY address_candidates.id
        ORDER BY CASE WHEN residential_buildings.class = 'apartments' THEN 0 ELSE 1 END,
          residential_buildings.id
      ) AS building_rank
    FROM address_candidates
    JOIN residential_buildings
      ON ST_Intersects(address_candidates.geometry, residential_buildings.geometry)
  ), classified AS (
    SELECT address_id, building_id, building_class
    FROM matches
    WHERE building_rank = 1
  ), residential_candidates AS (
    SELECT
      address_candidates.*,
      CASE WHEN classified.building_class = 'apartments' THEN 'apartment' ELSE 'residential' END AS property_type,
      classified.building_id AS residential_building_id,
      classified.building_class AS residential_building_class,
      row_number() OVER (
        PARTITION BY coalesce(nullif(trim(address_candidates.admin1), ''), '*')
        ORDER BY hash(address_candidates.id)
      ) AS residential_region_rank,
      row_number() OVER (
        PARTITION BY coalesce(nullif(trim(address_candidates.admin1), ''), '*'),
          coalesce(nullif(trim(address_candidates.locality), ''),
            concat('grid:', floor(address_candidates.latitude), ':', floor(address_candidates.longitude)))
        ORDER BY hash(address_candidates.id)
      ) AS residential_locality_rank
    FROM address_candidates
    JOIN classified ON classified.address_id = address_candidates.id
  ), balanced AS (
    SELECT 0 AS residential_priority, * EXCLUDE (residential_region_rank, residential_locality_rank)
    FROM residential_candidates WHERE residential_region_rank = 1
    UNION ALL
    SELECT 1 AS residential_priority, * EXCLUDE (residential_region_rank, residential_locality_rank)
    FROM residential_candidates
    WHERE residential_region_rank > 1 AND residential_locality_rank <= {args.per_locality}
  )
  SELECT
    balanced.* EXCLUDE (priority, residential_priority, geometry)
  FROM balanced
  ORDER BY residential_priority, hash(coalesce(nullif(trim(admin1), ''), '*')), hash(id)
  LIMIT {args.max_records}
) TO {output} (FORMAT JSON, ARRAY false);
"""
    try:
        connection.execute(classified_query)
    except Exception as error:
        pathlib.Path(args.output).unlink(missing_ok=True)
        print(f"Residential building classification failed; exporting address-only fallback: {error}", file=sys.stderr)
        connection.execute(fallback_query)
