import argparse
import csv
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict


RESIDENTIAL_ZONES = {
    "RESIDENTIAL 1 : CONVENTIONAL HOUSING",
    "RESIDENTIAL 2 : INCREMENTAL HOUSING",
    "GENERAL RESIDENTIAL 1 : GROUP HOUSING",
    "GENERAL RESIDENTIAL 2",
    "GENERAL RESIDENTIAL 3",
    "GENERAL RESIDENTIAL 4",
    "GENERAL RESIDENTIAL 5",
    "GENERAL RESIDENTIAL 6",
}


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
                    "Content-Type": "application/x-www-form-urlencoded",
                },
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
            town = clean(row.get("Town")).upper()
            if place and town and re.fullmatch(r"\d{4}", postcode):
                values[place].add((town, postcode))
    return values


def resolve_postcode(postcodes, suburb):
    matches = postcodes.get(key(suburb), set())
    return next(iter(matches)) if len(matches) == 1 else None


def valid_address(properties):
    suffix = clean(properties.get("ADR_NO_SFX")).upper()
    try:
        number = str(int(properties.get("ADR_NO")))
    except (TypeError, ValueError):
        return None
    street_name = clean(properties.get("STR_NAME")).upper()
    street_type = clean(properties.get("LU_STR_NAME_TYPE")).upper()
    suburb = clean(properties.get("OFC_SBRB_NAME")).upper()
    zoning = clean(properties.get("ZONING")).upper()
    if not 0 < int(number) <= 999999 or not re.fullmatch(r"[A-Z]{0,2}", suffix):
        return None
    if not re.search(r"[A-Z]", street_name) or not re.search(r"[A-Z]", street_type):
        return None
    if not re.search(r"[A-Z]", suburb) or zoning not in RESIDENTIAL_ZONES:
        return None
    return f"{number}{suffix}", f"{street_name} {street_type}", suburb, zoning


def object_ids(parcel_url):
    zones = ",".join(f"'{value.title()}'" for value in RESIDENTIAL_ZONES)
    payload = request_json(f"{parcel_url}/query", {
        "f": "json",
        "where": (
            "ADR_NO IS NOT NULL AND STR_NAME IS NOT NULL AND LU_STR_NAME_TYPE IS NOT NULL "
            f"AND OFC_SBRB_NAME IS NOT NULL AND ZONING IN ({zones})"
        ),
        "returnIdsOnly": "true",
    })
    values = payload.get("objectIds", [])
    return sorted(values, key=lambda value: hashlib.sha256(str(value).encode()).digest())


def parcel_features(parcel_url, identifiers):
    payload = request_json(f"{parcel_url}/query", {
        "f": "json",
        "objectIds": ",".join(map(str, identifiers)),
        "outFields": (
            "OBJECTID,ADR_NO,ADR_NO_SFX,OFC_SBRB_NAME,STR_NAME,"
            "LU_STR_NAME_TYPE,ZONING"
        ),
        "returnGeometry": "false",
        "returnCentroid": "true",
        "outSR": "4326",
    })
    return payload.get("features", [])


def record(feature, postcodes):
    properties = feature.get("attributes", {})
    parsed = valid_address(properties)
    centroid = feature.get("centroid", {})
    try:
        longitude, latitude = float(centroid["x"]), float(centroid["y"])
    except (KeyError, TypeError, ValueError):
        return None
    if not parsed or not 18.0 <= longitude <= 19.1 or not -34.5 <= latitude <= -33.3:
        return None
    number, street, suburb, zoning = parsed
    postal = resolve_postcode(postcodes, suburb)
    if not postal:
        return None
    postal_city, postcode = postal
    object_id = clean(properties.get("OBJECTID"))
    if not object_id:
        return None
    return {
        "id": f"cape-town-parcel:{object_id}",
        "source_record_id": f"cape-town-parcel:{object_id}",
        "source_dataset": "City of Cape Town Land Parcels; South African Post Office postal codes",
        "country": "ZA",
        "admin1": "Western Cape",
        "locality": postal_city,
        "district": suburb,
        "postal_city": postal_city,
        "address_levels": ["Western Cape", postal_city, suburb],
        "postcode": postcode,
        "street": street,
        "number": number,
        "longitude": longitude,
        "latitude": latitude,
        "property_type": "residential",
        "residential_building_id": f"cape-town-parcel:{object_id}",
        "residential_building_class": "residential",
        "residential_evidence": zoning,
    }


def records(parcel_url, postal_file, maximum, per_locality):
    postcodes = load_postcodes(postal_file)
    identifiers = object_ids(parcel_url)
    scan_limit = min(len(identifiers), max(30000, maximum * 10))
    selected = []
    locality_counts = defaultdict(int)
    seen = set()
    for offset in range(0, scan_limit, 2000):
        for feature in parcel_features(parcel_url, identifiers[offset:offset + 2000]):
            value = record(feature, postcodes)
            if not value:
                continue
            identity = tuple(key(value[field]) for field in ("number", "street", "district", "postcode"))
            locality_key = f"{value['locality']}\x1f{value['district']}"
            if identity in seen or locality_counts[locality_key] >= per_locality:
                continue
            seen.add(identity)
            locality_counts[locality_key] += 1
            selected.append(value)
        if len(selected) >= maximum:
            break
    return sorted(selected[:maximum], key=lambda value: (
        value["locality"], value["district"], value["street"], value["number"]
    ))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parcel-url", required=True)
    parser.add_argument("--postal-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-records", required=True, type=int)
    parser.add_argument("--per-locality", required=True, type=int)
    args = parser.parse_args()
    values = records(args.parcel_url, args.postal_file, args.max_records, args.per_locality)
    with open(args.output, "w", encoding="utf-8", newline="\n") as output:
        for value in values:
            output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
