import argparse
import concurrent.futures
import csv
import hashlib
import io
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from xml.sax.saxutils import escape


POSTCODE_PATTERN = re.compile(r"\d{6}")
ADDRESS_PATTERN = re.compile(r"^(.+?[縣市])(.+?[區鄉鎮市])(.+?)(\d+(?:[-之]\d+)?)號$")
BUILDING_CLASSES = {
    "公寓": "apartments",
    "住宅大樓": "apartments",
    "華廈": "apartments",
    "套房": "apartments",
    "透天厝": "house",
    "農舍": "house",
    "其他": "residential",
}
RESIDENTIAL_USES = {"住家用", "國民住宅"}
SOAP_URL = "https://33wsp.post.gov.tw/LZWZIP/TZIP33.asmx"


def clean(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or ""))).replace("台", "臺").strip()


def canonical_address(value):
    value = clean(value)
    if not value or re.search(r"[\ue000-\uf8ff]", value):
        return ""
    match = re.match(r"^(.+?號)", value)
    return match.group(1) if match else ""


def building_class(value):
    value = clean(value)
    return next((result for label, result in BUILDING_CLASSES.items() if label in value), "")


def address_parts(address):
    match = ADDRESS_PATTERN.fullmatch(address)
    if not match:
        return None
    admin1, locality, street, number = match.groups()
    if not street or not re.search(r"[\u3400-\u9fff]", street):
        return None
    return admin1, locality, street, number


def load_molit_candidates(paths):
    candidates = {}
    if isinstance(paths, (str, os.PathLike)):
        paths = [paths]
    for path in paths:
        with zipfile.ZipFile(path) as archive:
            names = sorted(name for name in archive.namelist() if re.fullmatch(r"[^/]+_lvr_land_a\.csv", name))
            for name in names:
                with archive.open(name) as binary:
                    rows = csv.DictReader(io.TextIOWrapper(binary, encoding="utf-8-sig", newline=""))
                    next(rows, None)
                    for row in rows:
                        if clean(row.get("主要用途")) not in RESIDENTIAL_USES:
                            continue
                        if not clean(row.get("交易標的")).startswith("房地"):
                            continue
                        residence_class = building_class(row.get("建物型態"))
                        address = canonical_address(row.get("土地位置建物門牌"))
                        parts = address_parts(address)
                        if not residence_class or not parts:
                            continue
                        admin1, locality, street, number = parts
                        declared_locality = clean(row.get("鄉鎮市區"))
                        if declared_locality != locality:
                            continue
                        candidates.setdefault(address, {
                            "address": address,
                            "admin1": admin1,
                            "locality": locality,
                            "street": street,
                            "number": number,
                            "residentialClass": residence_class,
                            "buildingType": clean(row.get("建物型態")),
                            "sourceRecordId": clean(row.get("編號")),
                        })
    return candidates


def row_value(row, *names):
    lookup = {str(key).upper(): value for key, value in row.items()}
    return next((lookup.get(name, "") for name in names if clean(lookup.get(name, ""))), "")


def oa_keys(row):
    region = clean(row_value(row, "REGION", "STATE", "ADMIN1"))
    city = clean(row_value(row, "CITY", "LOCALITY"))
    district = clean(row_value(row, "DISTRICT"))
    street = clean(row_value(row, "STREET"))
    number = clean(row_value(row, "NUMBER", "HOUSENUMBER")).removesuffix("號")
    direct = canonical_address(row_value(row, "ADDRESS"))
    keys = {direct} if direct else set()
    if street and number:
        suffix = f"{street}{number}號"
        for prefix in (f"{region}{city}{district}", f"{region}{district}{city}", f"{region}{city}",
                       f"{region}{district}", f"{city}{district}", f"{district}{city}"):
            value = canonical_address(f"{prefix}{suffix}")
            if value:
                keys.add(value)
    return keys


def oa_suffix_keys(row):
    city = clean(row_value(row, "CITY", "LOCALITY"))
    district = clean(row_value(row, "DISTRICT"))
    street = clean(row_value(row, "STREET"))
    number = clean(row_value(row, "NUMBER", "HOUSENUMBER")).removesuffix("號")
    if not street or not number:
        return set()
    tail = f"{street}{number}號"
    return {f"{prefix}{tail}" for prefix in (city, district) if prefix}


def candidate_suffix(candidate):
    return f"{candidate['locality']}{candidate['street']}{candidate['number']}號"


def load_oa_points(path, candidates):
    points = {}
    suffixes = defaultdict(list)
    for address, candidate in candidates.items():
        suffixes[candidate_suffix(candidate)].append(address)
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist()
                 if name.lower().endswith(".csv") and re.search(r"(^|/)tw(/|$)", name.lower())]
        for name in sorted(names):
            with archive.open(name) as binary:
                rows = csv.DictReader(io.TextIOWrapper(binary, encoding="utf-8-sig", newline=""))
                for row in rows:
                    try:
                        longitude = float(row_value(row, "LON", "LONGITUDE", "X"))
                        latitude = float(row_value(row, "LAT", "LATITUDE", "Y"))
                    except (TypeError, ValueError):
                        continue
                    if not (119 <= longitude <= 123 and 21 <= latitude <= 26):
                        continue
                    matches = [key for key in oa_keys(row) if key in candidates]
                    if not matches:
                        for suffix in oa_suffix_keys(row):
                            addresses = suffixes.get(suffix, [])
                            if len(addresses) == 1:
                                matches.extend(addresses)
                    for address in set(matches):
                        point = (longitude, latitude, name)
                        if address not in points:
                            points[address] = point
                        elif points[address] is not None and points[address][:2] != point[:2]:
                            points[address] = None
    return {address: point for address, point in points.items() if point is not None}


def load_postcode_cache(path):
    cache = {}
    if not path or not os.path.exists(path):
        return cache
    with open(path, encoding="utf-8") as source:
        for line in source:
            try:
                value = json.loads(line)
                cache[canonical_address(value["address"])] = value
            except (KeyError, TypeError, ValueError):
                continue
    return cache


def postal_lookup(address, attempts=5):
    body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
        f'<soap:Body><GetZipCode xmlns="http://tempuri.org/"><addrStr>{escape(address)}</addrStr>'
        '</GetZipCode></soap:Body></soap:Envelope>'
    ).encode("utf-8")
    request = urllib.request.Request(SOAP_URL, data=body, headers={
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": "http://tempuri.org/GetZipCode",
        "User-Agent": "address-sync/1.0",
    })
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                root = ET.fromstring(response.read())
            postcode = clean(root.findtext(".//{http://tempuri.org/}GetZipCodeResult"))
            postal_address = canonical_address(root.findtext(".//{http://tempuri.org/}address"))
            return {
                "address": address,
                "postcode": postcode if POSTCODE_PATTERN.fullmatch(postcode) else "",
                "postalAddress": postal_address,
                "postalExact": postal_address == address,
                "status": 200,
            }
        except urllib.error.HTTPError as error:
            if error.code not in {408, 429} and error.code < 500:
                return {"address": address, "postcode": "", "postalAddress": "", "postalExact": False,
                        "status": error.code}
        except (urllib.error.URLError, TimeoutError, ET.ParseError):
            pass
        if attempt + 1 < attempts:
            time.sleep(min(30, 2 ** attempt))
    return {"address": address, "postcode": "", "postalAddress": "", "postalExact": False, "status": 0}


def verified_postcode_value(address, value):
    postcode = clean(value.get("postcode"))
    postal_address = canonical_address(value.get("postalAddress"))
    return postcode if (POSTCODE_PATTERN.fullmatch(postcode)
                        and value.get("postalExact") is True
                        and postal_address == address) else ""


def verified_postcodes(addresses, cache, cache_file, request_interval, concurrency):
    resolved = {}
    pending = []
    for address in addresses:
        value = cache.get(address)
        status = int(value.get("status") or 0) if isinstance(value, dict) else 0
        if value is None or status == 0 or status in {408, 429} or status >= 500:
            pending.append(address)
        else:
            resolved[address] = verified_postcode_value(address, value)

    def lookup(address):
        value = postal_lookup(address)
        time.sleep(request_interval)
        return address, value

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(concurrency, 8))) as executor:
        with open(cache_file, "a", encoding="utf-8", newline="\n") as output:
            for address, value in executor.map(lookup, pending):
                cache[address] = value
                output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
                output.flush()
                resolved[address] = verified_postcode_value(address, value)
    return resolved


def load_verified_jsonl(path):
    records = []
    with open(path, encoding="utf-8") as source:
        for line in source:
            try:
                value = json.loads(line)
                address = canonical_address(value.get("address"))
                parts = address_parts(address)
                postcode = clean(value.get("postcode"))
                longitude = float(value.get("longitude"))
                latitude = float(value.get("latitude"))
            except (TypeError, ValueError):
                continue
            if (clean(value.get("use")) not in RESIDENTIAL_USES or not parts
                    or not POSTCODE_PATTERN.fullmatch(postcode)
                    or value.get("postalExact") is not True
                    or canonical_address(value.get("postalAddress")) != address
                    or not 119 <= longitude <= 123 or not 21 <= latitude <= 26):
                continue
            admin1, locality, street, number = parts
            residence_class = building_class(value.get("kind"))
            if residence_class:
                records.append({
                    "address": address, "admin1": admin1, "locality": locality,
                    "street": street, "number": number, "postcode": postcode,
                    "longitude": longitude, "latitude": latitude,
                    "residentialClass": residence_class, "buildingType": clean(value.get("kind")),
                    "sourceRecordId": "",
                })
    return records


def select_balanced(records, maximum, per_locality):
    grouped = defaultdict(list)
    for record in sorted(records, key=lambda item: (item["locality"], item["address"])):
        if len(grouped[record["locality"]]) < per_locality:
            grouped[record["locality"]].append(record)
    queues = [deque(values) for _, values in sorted(grouped.items())]
    selected = []
    while queues and len(selected) < maximum:
        remaining = []
        for queue in queues:
            if queue and len(selected) < maximum:
                selected.append(queue.popleft())
            if queue:
                remaining.append(queue)
        queues = remaining
    return selected


def output_record(record):
    identity = hashlib.sha256(record["address"].encode("utf-8")).hexdigest()[:24]
    residential_class = record["residentialClass"]
    return {
        "id": f"tw-molit-{identity}",
        "source_record_id": record.get("sourceRecordId") or f"tw-molit-{identity}",
        "country": "TW",
        "admin1": record["admin1"],
        "postal_city": record["locality"],
        "address_levels": [record["admin1"], record["locality"]],
        "postcode": record["postcode"],
        "street": record["street"],
        "number": record["number"],
        "longitude": record["longitude"],
        "latitude": record["latitude"],
        "property_type": "apartment" if residential_class == "apartments" else "residential",
        "residential_building_id": f"molit-residential:{identity}",
        "residential_building_class": residential_class,
        "source_dataset": "MOLIT residential transactions + official OpenAddresses points + Chunghwa Post 3+3",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--molit-archive", action="append")
    parser.add_argument("--openaddresses-archive")
    parser.add_argument("--verified-jsonl")
    parser.add_argument("--postcode-cache")
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-records", type=int, default=10000)
    parser.add_argument("--per-locality", type=int, default=1000)
    parser.add_argument("--request-interval", type=float, default=0.2)
    parser.add_argument("--postcode-concurrency", type=int, default=6)
    args = parser.parse_args()
    if args.verified_jsonl:
        records = load_verified_jsonl(args.verified_jsonl)
    else:
        if not args.molit_archive or not args.openaddresses_archive or not args.postcode_cache:
            parser.error("raw mode requires --molit-archive, --openaddresses-archive, and --postcode-cache")
        candidates = load_molit_candidates(args.molit_archive)
        points = load_oa_points(args.openaddresses_archive, candidates)
        cache = load_postcode_cache(args.postcode_cache)
        postcodes = verified_postcodes(
            sorted(points), cache, args.postcode_cache,
            max(0, args.request_interval), args.postcode_concurrency
        )
        records = []
        for address, point in sorted(points.items()):
            postcode = postcodes.get(address, "")
            if not postcode:
                continue
            candidate = dict(candidates[address])
            candidate.update({"postcode": postcode, "longitude": point[0], "latitude": point[1]})
            records.append(candidate)
    selected = select_balanced(records, max(0, args.max_records), max(1, args.per_locality))
    with open(args.output, "w", encoding="utf-8", newline="\n") as output:
        for record in selected:
            output.write(json.dumps(output_record(record), ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({"accepted": len(selected), "candidates": len(records)}, separators=(",", ":")))


if __name__ == "__main__":
    main()
