import argparse
import csv
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict


TOWNS = {
    "AMK": "Ang Mo Kio", "BB": "Bukit Batok", "BD": "Bedok", "BH": "Bishan",
    "BM": "Bukit Merah", "BP": "Bukit Panjang", "BT": "Bukit Timah",
    "CCK": "Choa Chu Kang", "CL": "Clementi", "CT": "Central Area",
    "GL": "Geylang", "HG": "Hougang", "JE": "Jurong East", "JW": "Jurong West",
    "KWN": "Kallang/Whampoa", "MP": "Marine Parade", "PG": "Punggol",
    "PRC": "Pasir Ris", "QT": "Queenstown", "SB": "Sembawang", "SGN": "Serangoon",
    "SK": "Sengkang", "TAP": "Tampines", "TG": "Tengah", "TP": "Toa Payoh",
    "WL": "Woodlands", "YS": "Yishun"
}

ROAD_WORDS = {
    "AVE": "AVENUE", "BT": "BUKIT", "CL": "CLOSE", "CRES": "CRESCENT",
    "CTRL": "CENTRAL", "CWEALTH": "COMMONWEALTH", "DR": "DRIVE",
    "GDNS": "GARDENS", "HTS": "HEIGHTS", "HWY": "HIGHWAY", "JLN": "JALAN",
    "KG": "KAMPONG", "LOR": "LORONG", "NTH": "NORTH", "PK": "PARK",
    "PL": "PLACE", "RD": "ROAD", "ST": "STREET", "STH": "SOUTH",
    "TER": "TERRACE", "TG": "TANJONG", "UPP": "UPPER"
}


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def block_key(value):
    return re.sub(r"\s+", "", clean(value).upper())


def street_code_prefix(value):
    words = re.findall(r"[A-Z0-9]+", clean(value).upper())
    return words[0][:2] + (words[1][:1] if len(words) > 1 else "") if words else ""


def road_key(value):
    words = re.findall(r"[A-Z0-9]+", clean(value).upper().replace("'", ""))
    return " ".join(ROAD_WORDS.get(word, word) for word in words)


def polygon_centroid(geometry):
    points = []

    def visit(value):
        if (isinstance(value, list) and len(value) >= 2
                and isinstance(value[0], (int, float)) and isinstance(value[1], (int, float))):
            points.append((float(value[0]), float(value[1])))
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit((geometry or {}).get("coordinates"))
    if not points:
        return None
    return sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points)


def positive_integer(value):
    try:
        return int(value) > 0
    except (TypeError, ValueError):
        return False


def load_properties(path):
    grouped = defaultdict(list)
    with open(path, encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            if clean(row.get("residential")).upper() != "Y" or not positive_integer(row.get("total_dwelling_units")):
                continue
            key = block_key(row.get("blk_no")), street_code_prefix(row.get("street"))
            if all(key):
                grouped[key].append(row)
    return grouped


def load_buildings(path):
    grouped = defaultdict(list)
    with open(path, encoding="utf-8") as source:
        payload = json.load(source)
    for feature in payload.get("features", []):
        properties = feature.get("properties") or {}
        postcode = clean(properties.get("POSTAL_COD"))
        code = clean(properties.get("ST_COD")).upper()
        point = polygon_centroid(feature.get("geometry"))
        if not re.fullmatch(r"\d{6}", postcode) or len(code) < 3 or not point:
            continue
        longitude, latitude = point
        if not (103 <= longitude <= 105 and 1 <= latitude <= 2):
            continue
        key = block_key(properties.get("BLK_NO")), code[:3]
        if all(key):
            grouped[key].append((properties, longitude, latitude))
    return grouped


def load_onemap_cache(path):
    cached = {}
    if not path or not os.path.exists(path):
        return cached
    with open(path, encoding="utf-8") as source:
        for line in source:
            try:
                value = json.loads(line)
                cached[value["query"]] = value.get("result")
            except (KeyError, TypeError, ValueError):
                continue
    return cached


def onemap_result(row, token, cache, cache_file, minimum_interval=0.2):
    query = f"{clean(row.get('blk_no'))} {clean(row.get('street'))}"
    if query in cache:
        return cache[query]
    parameters = urllib.parse.urlencode({
        "searchVal": query, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": "1"
    })
    request = urllib.request.Request(
        f"https://www.onemap.gov.sg/api/common/elastic/search?{parameters}",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "address-sync/1.0"}
    )
    payload = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
            break
        except urllib.error.HTTPError as error:
            if error.code in {401, 403}:
                raise
            if error.code == 429 or error.code == 408 or error.code >= 500:
                if attempt < 4:
                    time.sleep(min(60, 2 ** attempt))
                    continue
            break
        except urllib.error.URLError:
            if attempt < 4:
                time.sleep(min(30, 2 ** attempt))
                continue
            break
    postcodes = defaultdict(list)
    for value in (payload or {}).get("results", []):
        postcode = clean(value.get("POSTAL"))
        try:
            longitude = float(value.get("LONGITUDE"))
            latitude = float(value.get("LATITUDE"))
        except (TypeError, ValueError):
            continue
        if (block_key(value.get("BLK_NO")) != block_key(row.get("blk_no"))
                or road_key(value.get("ROAD_NAME")) != road_key(row.get("street"))
                or not re.fullmatch(r"\d{6}", postcode)
                or not 103 <= longitude <= 105 or not 1 <= latitude <= 2):
            continue
        postcodes[postcode].append((longitude, latitude))
    result = None
    if len(postcodes) == 1:
        postcode, points = next(iter(postcodes.items()))
        result = {
            "POSTAL_COD": postcode,
            "longitude": sum(point[0] for point in points) / len(points),
            "latitude": sum(point[1] for point in points) / len(points)
        }
    cache[query] = result
    with open(cache_file, "a", encoding="utf-8", newline="\n") as output:
        output.write(json.dumps({"query": query, "result": result}, ensure_ascii=False, separators=(",", ":")) + "\n")
    time.sleep(minimum_interval)
    return result


def records(property_file, building_file, onemap_cache_file=None):
    properties = load_properties(property_file)
    buildings = load_buildings(building_file)
    token = clean(os.environ.get("ONEMAP_ACCESS_TOKEN"))
    onemap_cache = load_onemap_cache(onemap_cache_file)
    for key in sorted(properties):
        property_rows = properties[key]
        building_rows = buildings.get(key, [])
        if len(property_rows) != 1:
            continue
        row = property_rows[0]
        if len(building_rows) == 1:
            building, longitude, latitude = building_rows[0]
        elif token and onemap_cache_file:
            building = onemap_result(row, token, onemap_cache, onemap_cache_file)
            if not building:
                continue
            longitude, latitude = building["longitude"], building["latitude"]
        else:
            continue
        town_code = clean(row.get("bldg_contract_town")).upper()
        town = TOWNS.get(town_code)
        if not town:
            continue
        entity_id = clean(building.get("ENTITYID")) or "onemap"
        object_id = clean(building.get("OBJECTID")) or clean(building.get("POSTAL_COD"))
        yield {
            "id": f"hdb-building:{entity_id}:{object_id}",
            "source_record_id": f"hdb-building:{entity_id}:{object_id}",
            "source_dataset": "HDB Property Information + HDB Existing Building",
            "country": "SG",
            "admin1": "Singapore",
            "locality": town,
            "postal_city": "Singapore",
            "address_levels": ["Singapore", town],
            "postcode": clean(building.get("POSTAL_COD")),
            "street": clean(row.get("street")),
            "number": clean(row.get("blk_no")),
            "longitude": longitude,
            "latitude": latitude,
            "property_type": "apartment",
            "residential_building_id": f"hdb-property:{key[0]}:{key[1]}",
            "residential_building_class": "apartments"
        }


def select_balanced(values, maximum, per_locality):
    by_postcode = {}
    for value in values:
        postcode = value["postcode"]
        existing = by_postcode.get(postcode)
        if existing is None or (":onemap:" in existing["id"] and ":onemap:" not in value["id"]):
            by_postcode[postcode] = value
    buckets = defaultdict(list)
    for value in by_postcode.values():
        buckets[value["locality"]].append(value)
    selected = []
    for locality in sorted(buckets):
        selected.extend(buckets[locality][:per_locality])
    return sorted(selected, key=lambda value: (value["locality"], value["street"], value["number"]))[:maximum]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--property-csv", required=True)
    parser.add_argument("--building-geojson", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--onemap-cache")
    parser.add_argument("--max-records", type=int, required=True)
    parser.add_argument("--per-locality", type=int, required=True)
    args = parser.parse_args()
    selected = select_balanced(
        records(args.property_csv, args.building_geojson, args.onemap_cache),
        args.max_records, args.per_locality
    )
    with open(args.output, "w", encoding="utf-8", newline="\n") as output:
        for value in selected:
            output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
