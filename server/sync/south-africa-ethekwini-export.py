import argparse
import concurrent.futures
import csv
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict


RESIDENTIAL_WHERE = (
    "ZONING LIKE '%RESIDENTIAL%' OR ZONING LIKE '%HOUSING%' "
    "OR ZONING='RETIREMENT VILLAGE'"
)


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def key(value):
    return re.sub(r"[^A-Z0-9]", "", clean(value).upper())


def request_json(url, parameters=None, attempts=5):
    encoded = urllib.parse.urlencode(parameters or {}).encode()
    use_post = len(encoded) > 1500
    target = url if use_post or not encoded else f"{url}?{encoded.decode()}"
    last_error = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                target,
                data=encoded if use_post else None,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded"
                }
            )
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = json.load(response)
            if "error" in payload:
                raise RuntimeError(payload["error"].get("message", "ArcGIS query failed"))
            return payload
        except (OSError, ValueError, RuntimeError, urllib.error.HTTPError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(min(8, 2 ** attempt))
    raise last_error


def load_postcodes(path):
    values = defaultdict(set)
    with open(path, encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            postcode = clean(row.get("StrCode"))
            place = key(row.get("PlaceName"))
            town = key(row.get("Town"))
            if place and town and re.fullmatch(r"\d{4}", postcode):
                values[(place, town)].add(postcode)
    return values


def resolve_postcode(postcodes, suburb, district):
    matches = postcodes.get((key(suburb), key(district)), set())
    return next(iter(matches)) if len(matches) == 1 else ""


def valid_address(properties):
    number = clean(properties.get("STRNUM")).upper()
    street = clean(properties.get("STRNAME")).upper()
    street_type = clean(properties.get("STRTYPE")).upper()
    suburb = clean(properties.get("SUBURB")).upper()
    district = clean(properties.get("DISTRICT")).upper()
    if not re.fullmatch(r"\d{1,6}[A-Z]?", number):
        return None
    if not re.search(r"[A-Z]", street) or not suburb or not district:
        return None
    return number, " ".join(filter(None, (street, street_type))), suburb, district


def residential_zoning(zoning_url, longitude, latitude):
    payload = request_json(f"{zoning_url}/query", {
        "f": "json",
        "where": RESIDENTIAL_WHERE,
        "geometry": f"{longitude},{latitude}",
        "geometryType": "esriGeometryPoint",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "OBJECTID,ZONING",
        "returnGeometry": "false",
        "resultRecordCount": "2"
    })
    zones = payload.get("features", [])
    if len(zones) != 1:
        return None
    attributes = zones[0].get("attributes", {})
    zone = clean(attributes.get("ZONING")).upper()
    if not ("RESIDENTIAL" in zone or "HOUSING" in zone or zone == "RETIREMENT VILLAGE"):
        return None
    return clean(attributes.get("OBJECTID")), zone


def object_ids(address_url):
    payload = request_json(f"{address_url}/query", {
        "f": "json",
        "where": "STRNUM IS NOT NULL AND STRNAME IS NOT NULL AND SUBURB IS NOT NULL AND DISTRICT IS NOT NULL",
        "returnIdsOnly": "true"
    })
    values = payload.get("objectIds", [])
    return sorted(values, key=lambda value: hashlib.sha256(str(value).encode()).digest())


def address_features(address_url, identifiers):
    payload = request_json(f"{address_url}/query", {
        "f": "geojson",
        "objectIds": ",".join(map(str, identifiers)),
        "outFields": "OBJECTID,STRNUM,STRNAME,STRTYPE,SUBURB,DISTRICT",
        "returnGeometry": "true",
        "outSR": "4326"
    })
    return payload.get("features", [])


def candidate(feature, postcodes):
    properties = feature.get("properties", {})
    parsed = valid_address(properties)
    geometry = feature.get("geometry", {})
    coordinates = geometry.get("coordinates", []) if geometry.get("type") == "Point" else []
    if not parsed or len(coordinates) < 2:
        return None
    longitude, latitude = map(float, coordinates[:2])
    if not 29 <= longitude <= 32 or not -31.5 <= latitude <= -28.5:
        return None
    number, street, suburb, district = parsed
    postcode = resolve_postcode(postcodes, suburb, district)
    if not postcode:
        return None
    return {
        "object_id": clean(properties.get("OBJECTID") or feature.get("id")),
        "number": number,
        "street": street,
        "suburb": suburb,
        "district": district,
        "postcode": postcode,
        "longitude": longitude,
        "latitude": latitude
    }


def verified_record(value, zoning_url):
    try:
        zoning = residential_zoning(zoning_url, value["longitude"], value["latitude"])
    except (OSError, ValueError, RuntimeError, urllib.error.HTTPError):
        return None
    if not zoning:
        return None
    zone_id, zone_name = zoning
    return {
        "id": f"ethekwini-address:{value['object_id']}",
        "source_record_id": f"ethekwini-address:{value['object_id']}",
        "source_dataset": "eThekwini Street Address + Zoning; South African Post Office postal codes",
        "country": "ZA",
        "admin1": "KwaZulu-Natal",
        "locality": value["district"],
        "district": value["suburb"],
        "postal_city": value["district"],
        "address_levels": ["KwaZulu-Natal", value["district"], value["suburb"]],
        "postcode": value["postcode"],
        "street": value["street"],
        "number": value["number"],
        "longitude": value["longitude"],
        "latitude": value["latitude"],
        "property_type": "residential",
        "residential_building_id": f"ethekwini-zoning:{zone_id}",
        "residential_building_class": "residential",
        "residential_evidence": zone_name
    }


def records(address_url, zoning_url, postal_file, maximum, per_locality, concurrency=16):
    postcodes = load_postcodes(postal_file)
    identifiers = object_ids(address_url)
    scan_limit = min(len(identifiers), max(30000, maximum * 8))
    selected = []
    locality_counts = defaultdict(int)
    for offset in range(0, scan_limit, 500):
        features = address_features(address_url, identifiers[offset:offset + 500])
        candidates = [value for value in (candidate(feature, postcodes) for feature in features) if value]
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
            verified = executor.map(lambda value: verified_record(value, zoning_url), candidates)
            for value in verified:
                if not value:
                    continue
                locality_key = f"{value['locality']}\x1f{value['district']}"
                if locality_counts[locality_key] >= per_locality:
                    continue
                locality_counts[locality_key] += 1
                selected.append(value)
        if len(selected) >= maximum:
            break
    return sorted(selected[:maximum], key=lambda value: (
        value["locality"], value["district"], value["street"], value["number"]
    ))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--address-url", required=True)
    parser.add_argument("--zoning-url", required=True)
    parser.add_argument("--postal-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-records", required=True, type=int)
    parser.add_argument("--per-locality", required=True, type=int)
    parser.add_argument("--concurrency", type=int, default=16)
    args = parser.parse_args()
    values = records(
        args.address_url, args.zoning_url, args.postal_file,
        args.max_records, args.per_locality, max(1, min(args.concurrency, 24))
    )
    with open(args.output, "w", encoding="utf-8", newline="\n") as output:
        for value in values:
            output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
