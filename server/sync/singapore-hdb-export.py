import argparse
import csv
import datetime
import hashlib
import json
import os
import re
import time
import urllib.error
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


class TemporaryOnemapFailure(RuntimeError):
    def __init__(self, kind, next_available_at=None):
        super().__init__(f"OneMap is temporarily unavailable ({kind})")
        self.kind = kind
        self.next_available_at = next_available_at


class RecordBatch(list):
    def __init__(self, values, source_complete, checkpoint_token, candidate_count, resolved_count,
                 temporary_failure=None, next_available_at=None, onemap_request_count=0):
        super().__init__(values)
        self.source_complete = source_complete
        self.checkpoint_token = checkpoint_token
        self.candidate_count = candidate_count
        self.resolved_count = resolved_count
        self.temporary_failure = temporary_failure
        self.next_available_at = next_available_at
        self.onemap_request_count = onemap_request_count


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
                result = value.get("result")
                status = value.get("status") or ("found" if isinstance(result, dict) else None)
                if status in {"found", "not_found"}:
                    cached[value["query"]] = {"status": status, "result": result}
            except (KeyError, TypeError, ValueError):
                continue
    return cached


def onemap_result(row, bridge_url, cache, cache_file, minimum_interval=1.05):
    query = f"{clean(row.get('blk_no'))} {clean(row.get('street'))}"
    if query in cache:
        return cache[query]["result"]
    request = urllib.request.Request(
        bridge_url,
        data=json.dumps({"query": query}, separators=(",", ":")).encode("utf-8"),
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    payload = None
    network_attempts = 0
    rate_limit_attempts = 0
    while True:
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
            if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
                raise ValueError("OneMap bridge response has no results")
            break
        except urllib.error.HTTPError as error:
            try:
                details = json.load(error)
            except (json.JSONDecodeError, UnicodeDecodeError):
                details = {}
            code = clean(details.get("code")).upper()
            next_available_at = details.get("nextAvailableAt") or details.get("next_available_at")
            if code == "SOURCE_RATE_LIMITED" or (error.code == 429 and "QUOTA" not in code
                                                   and "QUOTA" not in str(details.get("message", "")).upper()):
                if rate_limit_attempts < 8:
                    rate_limit_attempts += 1
                    retry_at = next_available_at
                    delay = minimum_interval
                    if retry_at:
                        try:
                            retry_time = datetime.datetime.fromisoformat(str(retry_at).replace("Z", "+00:00"))
                            delay = max(delay, min(10.0, retry_time.timestamp() - time.time()))
                        except (TypeError, ValueError, OverflowError):
                            pass
                    time.sleep(max(0.05, delay))
                    continue
                raise TemporaryOnemapFailure("rate_limit", next_available_at) from None
            if code == "SOURCE_QUOTA_UNAVAILABLE" or "QUOTA" in code:
                raise TemporaryOnemapFailure("quota", next_available_at) from None
            if error.code in {401, 403} or "CREDENTIAL" in code:
                raise TemporaryOnemapFailure("credential", next_available_at) from None
            if error.code == 408 or error.code >= 500 or "NETWORK" in code:
                if network_attempts < 2:
                    time.sleep(2 ** network_attempts)
                    network_attempts += 1
                    continue
                raise TemporaryOnemapFailure("network", next_available_at) from None
            raise RuntimeError(f"OneMap bridge stopped with HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
            if network_attempts < 2:
                time.sleep(2 ** network_attempts)
                network_attempts += 1
                continue
            raise TemporaryOnemapFailure("network") from None
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
    status = "found" if result else "not_found"
    cache[query] = {"status": status, "result": result}
    os.makedirs(os.path.dirname(os.path.abspath(cache_file)), exist_ok=True)
    with open(cache_file, "a", encoding="utf-8", newline="\n") as output:
        output.write(json.dumps({"query": query, "status": status, "result": result},
                                ensure_ascii=False, separators=(",", ":")) + "\n")
    time.sleep(max(0, minimum_interval))
    return result


def checkpoint_token(cache):
    state = [(query, entry["status"], entry["result"]) for query, entry in sorted(cache.items())]
    return hashlib.sha256(json.dumps(state, ensure_ascii=False, separators=(",", ":"),
                                     sort_keys=True).encode("utf-8")).hexdigest()


def records(property_file, building_file, onemap_cache_file, bridge_url, minimum_interval=1.05,
            max_onemap_requests=500):
    properties = load_properties(property_file)
    buildings = load_buildings(building_file)
    onemap_cache = load_onemap_cache(onemap_cache_file)
    output = []
    candidate_count = 0
    resolved_count = 0
    onemap_request_count = 0
    failure = None
    for key in sorted(properties):
        property_rows = properties[key]
        building_rows = buildings.get(key, [])
        if len(property_rows) != 1:
            continue
        candidate_count += 1
        row = property_rows[0]
        if len(building_rows) == 1:
            building, longitude, latitude = building_rows[0]
            resolved_count += 1
        else:
            query = f"{clean(row.get('blk_no'))} {clean(row.get('street'))}"
            if query not in onemap_cache:
                if failure is not None:
                    continue
                if onemap_request_count >= max_onemap_requests:
                    failure = TemporaryOnemapFailure("request_budget")
                    continue
                onemap_request_count += 1
            try:
                building = onemap_result(row, bridge_url, onemap_cache, onemap_cache_file, minimum_interval)
            except TemporaryOnemapFailure as error:
                failure = error
                continue
            resolved_count += 1
            if not building:
                continue
            longitude, latitude = building["longitude"], building["latitude"]
        town_code = clean(row.get("bldg_contract_town")).upper()
        town = TOWNS.get(town_code)
        if not town:
            continue
        entity_id = clean(building.get("ENTITYID")) or "onemap"
        object_id = clean(building.get("OBJECTID")) or clean(building.get("POSTAL_COD"))
        output.append({
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
        })
    source_complete = failure is None and resolved_count == candidate_count
    return RecordBatch(
        output,
        source_complete,
        None if source_complete else checkpoint_token(onemap_cache),
        candidate_count,
        resolved_count,
        failure.kind if failure else None,
        failure.next_available_at if failure else None,
        onemap_request_count,
    )


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
    parser.add_argument("--onemap-cache", required=True)
    parser.add_argument("--onemap-bridge-url", required=True)
    parser.add_argument("--state-output", required=True)
    parser.add_argument("--minimum-interval", type=float, default=1.05)
    parser.add_argument("--max-onemap-requests", type=int, default=500)
    parser.add_argument("--max-records", type=int, required=True)
    parser.add_argument("--per-locality", type=int, required=True)
    args = parser.parse_args()
    if (args.max_records < 1 or args.per_locality < 1 or args.minimum_interval < 0
            or args.max_onemap_requests < 1):
        raise ValueError("Invalid export limits")
    batch = records(args.property_csv, args.building_geojson, args.onemap_cache,
                    args.onemap_bridge_url, args.minimum_interval, args.max_onemap_requests)
    selected = select_balanced(batch, args.max_records, args.per_locality)
    with open(args.output, "w", encoding="utf-8", newline="\n") as output:
        for value in selected:
            output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    state = {
        "version": 1,
        "source_complete": batch.source_complete,
        "checkpoint_token": batch.checkpoint_token,
        "candidate_count": batch.candidate_count,
        "resolved_count": batch.resolved_count,
        "publishable_count": len(batch),
        "selected_count": len(selected),
        "temporary_failure": batch.temporary_failure,
        "next_available_at": batch.next_available_at,
        "onemap_request_count": batch.onemap_request_count,
    }
    absolute = os.path.abspath(args.state_output)
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    temporary = f"{absolute}.{os.getpid()}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as output:
            json.dump(state, output, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            output.write("\n")
        os.replace(temporary, absolute)
    finally:
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
