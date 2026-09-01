import argparse
import csv
import hashlib
import io
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict, deque


DISTRICTS = {
    "Central & Western": "中西區",
    "Eastern": "東區",
    "Islands": "離島區",
    "Kowloon City": "九龍城區",
    "Kwai Tsing": "葵青區",
    "Kwun Tong": "觀塘區",
    "North": "北區",
    "Sai Kung": "西貢區",
    "Sha Tin": "沙田區",
    "Sham Shui Po": "深水埗區",
    "Southern": "南區",
    "Tai Po": "大埔區",
    "Tsuen Wan": "荃灣區",
    "Tuen Mun": "屯門區",
    "Wan Chai": "灣仔區",
    "Wong Tai Sin": "黃大仙區",
    "Yau Tsim Mong": "油尖旺區",
    "Yuen Long": "元朗區",
}
REGIONS = {
    "Hong Kong": "香港島",
    "Hong Kong Island": "香港島",
    "Kowloon": "九龍",
    "Kowloon East": "九龍",
    "Kowloon West": "九龍",
    "New Territories": "新界",
    "New Territories East": "新界",
    "New Territories West": "新界",
}
HOUSING_REGIONS = {
    "Hong Kong Island": ("Hong Kong", "香港島", "香港島", "HK"),
    "Kowloon East": ("Kowloon", "九龍", "九龍東", "KLN"),
    "Kowloon West": ("Kowloon", "九龍", "九龍西", "KLN"),
    "New Territories East": ("New Territories", "新界", "新界東", "NT"),
    "New Territories West": ("New Territories", "新界", "新界西", "NT"),
}
STREET_SUFFIXES = (
    "STREET", "ROAD", "AVENUE", "LANE", "DRIVE", "PATH", "WAY", "PLACE",
    "CRESCENT", "TERRACE", "GARDENS", "GARDEN", "CLOSE", "COURT", "SQUARE",
    "BOULEVARD", "PROMENADE", "WALK", "ALLEY", "STEPS", "GDNS", "GDN",
    "CRES", "AVE", "TERR", "RD", "ST", "DR", "LN", "CL", "CT", "PL",
)
CHINESE_STREET = re.compile(
    r"(?P<street>[^\s,，]{1,40}(?:街|道|路|里|徑|坊|圍|臺|台|巷|堤岸))\s*"
    r"(?P<number>\d+(?:\s*[-至]\s*\d+)?[A-Za-z]?)號"
)
ENGLISH_STREET = re.compile(
    rf"\b(?P<number>\d+(?:\s*[-–]\s*\d+)?[A-Z]?)\s+"
    rf"(?P<street>[A-Z][A-Z0-9 .'’/-]{{0,70}}?\s(?:{'|'.join(STREET_SUFFIXES)}))\b",
    re.IGNORECASE,
)
ALS_URL = "https://www.als.gov.hk/lookup"


def clean(value):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip(" ,，")


def key(value):
    return re.sub(r"[^0-9A-Za-z\u3400-\u9fff]", "", clean(value)).casefold()


def bilingual(chinese, english):
    chinese = clean(chinese)
    english = clean(english)
    return " ".join(value for value in (chinese, english) if value)


def valid_coordinates(longitude, latitude):
    try:
        longitude = float(longitude)
        latitude = float(latitude)
    except (TypeError, ValueError):
        return None
    if not 113.8 <= longitude <= 114.5 or not 22.1 <= latitude <= 22.6:
        return None
    return longitude, latitude


def normalized_district(english, chinese):
    english = clean(english).removesuffix(" District").title()
    expected = DISTRICTS.get(english)
    if not expected or key(clean(chinese).removesuffix("區")) != key(expected.removesuffix("區")):
        return None
    return english, expected


def normalized_region(english, chinese):
    english = clean(english).title()
    expected = REGIONS.get(english)
    if not expected or key(chinese) != key(expected):
        return None
    return english, expected


def parse_street(address_chinese, address_english):
    chinese_matches = list(CHINESE_STREET.finditer(clean(address_chinese)))
    english_matches = list(ENGLISH_STREET.finditer(clean(address_english)))
    if len(chinese_matches) != 1 or len(english_matches) != 1:
        return None
    chinese_match = chinese_matches[0]
    chinese_street = clean(chinese_match.group("street"))
    if (len(chinese_street) > 10 or re.search(r"[A-Za-z]", chinese_street)
            or any(marker in chinese_street for marker in ("號", "及"))
            or chinese_street.startswith(("香港", "九龍", "新界"))):
        return None
    chinese_number = clean(chinese_match.group("number")).replace("至", "-").replace(" ", "")
    compatible = []
    for match in english_matches:
        english_number = clean(match.group("number")).replace("–", "-").replace(" ", "").upper()
        if english_number == chinese_number.upper():
            compatible.append(match)
    if len(compatible) != 1:
        return None
    english_match = compatible[0]
    return {
        "street_chinese": chinese_street,
        "street_english": clean(english_match.group("street")).upper(),
        "number": chinese_number,
    }


def private_candidate(row):
    if clean(row.get("NSEARCH5_E")) != "Residential/Composite" or clean(row.get("NSEARCH4_E")) != "Tower":
        return None
    district = normalized_district(row.get("SEARCH1_E"), row.get("SEARCH1_C"))
    region = normalized_region(row.get("SEARCH2_E"), row.get("SEARCH2_C"))
    coordinates = valid_coordinates(row.get("LONGITUDE"), row.get("LATITUDE"))
    building_id = clean(row.get("NSEARCH1_E"))
    object_id = clean(row.get("OBJECTID"))
    address_chinese = clean(row.get("ADDRESS_C"))
    address_english = clean(row.get("ADDRESS_E"))
    street = parse_street(address_chinese, address_english)
    if not district or not region or not coordinates or not building_id or not object_id or not street:
        return None
    district_en, district_zh = district
    region_en, region_zh = region
    longitude, latitude = coordinates
    identity = "\x1f".join((key(address_chinese), key(address_english), building_id))
    return {
        "id": f"hk-bd:{object_id}",
        "source_record_id": f"hk-bd:{object_id}",
        "source_dataset": "Hong Kong Buildings Department building information and age records",
        "country": "HK",
        "admin1": bilingual(region_zh, region_en),
        "locality": bilingual(district_zh, f"{district_en} District"),
        "postal_city": bilingual(district_zh, f"{district_en} District"),
        "address_levels": [bilingual(region_zh, region_en), bilingual(district_zh, f"{district_en} District")],
        "street": bilingual(street["street_chinese"], street["street_english"]),
        "number": street["number"],
        "building_name": "",
        "longitude": longitude,
        "latitude": latitude,
        "property_type": "apartment",
        "residential_building_id": f"hk-bd-block:{building_id}",
        "residential_building_class": "apartments",
        "official_address": address_chinese,
        "official_address_en": address_english,
        "source_rank": hashlib.sha256(identity.encode("utf-8")).hexdigest(),
        "dedupe_key": f"bd:{key(address_chinese)}:{key(address_english)}",
    }


def csv_rows(path):
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            names = sorted(name for name in archive.namelist() if name.lower().endswith(".csv"))
            for name in names:
                with archive.open(name) as binary:
                    yield from csv.DictReader(io.TextIOWrapper(binary, encoding="utf-8-sig", newline=""))
        return
    with open(path, encoding="utf-8-sig", newline="") as source:
        yield from csv.DictReader(source)


def private_records(paths):
    for path in paths:
        for row in csv_rows(path):
            value = private_candidate(row)
            if value:
                yield value


def als_cache_key(row):
    return ":".join((
        key(row.get("region_chinese_name")),
        key(row.get("district_chinese_name")),
        key(row.get("estate_chinese_name")),
        key(row.get("chinese_name_of_block")),
    ))


def parse_als_xml(payload, housing_row):
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        return None
    expected_estate = key(housing_row.get("estate_chinese_name"))
    expected_building = key(housing_row.get("chinese_name_of_block"))
    expected_district = key(f"{clean(housing_row.get('district_chinese_name')).removesuffix('區')}區")
    matches = []
    for suggested in root.findall(".//SuggestedAddress"):
        premises = suggested.find("./Address/PremisesAddress")
        if premises is None:
            continue
        chinese = premises.find("./ChiPremisesAddress")
        english = premises.find("./EngPremisesAddress")
        geo = premises.find("./GeospatialInformation")
        if chinese is None or english is None or geo is None:
            continue
        estate_zh = clean(chinese.findtext("./ChiEstate/EstateName"))
        building_zh = clean(chinese.findtext("./BuildingName"))
        district_zh = clean(chinese.findtext("./ChiDistrict/DcDistrict"))
        if (key(estate_zh) != expected_estate or key(building_zh) != expected_building
                or key(district_zh) != expected_district):
            continue
        coordinates = valid_coordinates(geo.findtext("./Longitude"), geo.findtext("./Latitude"))
        street_zh = clean(chinese.findtext("./ChiStreet/StreetName"))
        number = clean(chinese.findtext("./ChiStreet/BuildingNoFrom"))
        street_en = clean(english.findtext("./EngStreet/StreetName"))
        if (not coordinates or not street_zh or not street_en
                or not re.fullmatch(r"\d+(?:-\d+)?[A-Za-z]?", number)):
            continue
        result = {
            "geo_address": clean(premises.findtext("./GeoAddress")),
            "region_chinese": clean(chinese.findtext("./Region")),
            "region_english": clean(english.findtext("./Region")),
            "district_chinese": district_zh,
            "district_english": clean(english.findtext("./EngDistrict/DcDistrict")),
            "locality_chinese": clean(chinese.findtext("./ChiStreet/LocationName")),
            "locality_english": clean(english.findtext("./EngStreet/LocationName")),
            "street_chinese": street_zh,
            "street_english": street_en,
            "number": number,
            "estate_chinese": estate_zh,
            "estate_english": clean(english.findtext("./EngEstate/EstateName")),
            "building_chinese": building_zh,
            "building_english": clean(english.findtext("./BuildingName")),
            "longitude": coordinates[0],
            "latitude": coordinates[1],
        }
        matches.append(result)
    unique = {json.dumps(value, ensure_ascii=False, sort_keys=True): value for value in matches}
    return next(iter(unique.values())) if len(unique) == 1 else None


def als_lookup(row, attempts=4):
    query = f"{clean(row.get('chinese_name_of_block'))} {clean(row.get('estate_chinese_name'))}"
    url = f"{ALS_URL}?{urllib.parse.urlencode({'q': query})}"
    request = urllib.request.Request(url, headers={"Accept": "application/xml", "User-Agent": "address-sync/1.0"})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return parse_als_xml(response.read(), row)
        except urllib.error.HTTPError as error:
            if error.code not in {408, 429} and error.code < 500:
                raise
        except (urllib.error.URLError, TimeoutError):
            pass
        if attempt + 1 < attempts:
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"ALS lookup failed after {attempts} attempts: {query}")


def load_als_cache(path):
    cached = {}
    if not path or not os.path.exists(path):
        return cached
    with open(path, encoding="utf-8") as source:
        for line in source:
            try:
                value = json.loads(line)
                cached[value["key"]] = value.get("result")
            except (KeyError, TypeError, ValueError):
                continue
    return cached


def housing_candidate(row, address):
    district_en = clean(row.get("district_english_name")).title()
    district_zh = f"{clean(row.get('district_chinese_name')).removesuffix('區')}區"
    district = normalized_district(district_en, district_zh)
    source_region = clean(row.get("region_english_name")).title()
    housing_region = HOUSING_REGIONS.get(source_region)
    if not housing_region or key(row.get("region_chinese_name")) != key(housing_region[2]):
        return None
    region_name, region_zh, _, als_region = housing_region
    region = normalized_region(region_name, region_zh)
    block_zh = clean(row.get("chinese_name_of_block"))
    block_en = clean(row.get("english_name_of_block"))
    estate_zh = clean(row.get("estate_chinese_name"))
    estate_en = clean(row.get("estate_english_name"))
    floor = clean(row.get("floor_number"))
    flat = clean(row.get("flat_number"))
    if not district or not region or not all((block_zh, block_en, estate_zh, estate_en, floor, flat, address)):
        return None
    if key(address.get("building_chinese")) != key(block_zh) or key(address.get("estate_chinese")) != key(estate_zh):
        return None
    coordinates = valid_coordinates(address.get("longitude"), address.get("latitude"))
    estate_coordinates = valid_coordinates(row.get("estate_map_longitude"), row.get("estate_map_latitude"))
    if not coordinates or not estate_coordinates:
        return None
    longitude, latitude = coordinates
    if abs(longitude - estate_coordinates[0]) > 0.02 or abs(latitude - estate_coordinates[1]) > 0.02:
        return None
    district_en, district_zh = district
    region_en, region_zh = region
    geo_address = clean(address.get("geo_address"))
    if (not geo_address or clean(address.get("region_english")).upper() != als_region
            or key(address.get("region_chinese")) != key(region_zh)
            or key(address.get("district_chinese")) != key(district_zh)
            or key(clean(address.get("district_english")).lower().removesuffix(" district")) != key(district_en)):
        return None
    location = bilingual(address.get("locality_chinese"), address.get("locality_english"))
    unit = bilingual(f"{floor}樓{flat}室", f"{floor}/F Flat {flat}")
    identity = "\x1f".join((geo_address, floor, flat))
    return {
        "id": f"hk-ha:{geo_address}:{floor}:{flat}",
        "source_record_id": f"hk-ha:{geo_address}:{floor}:{flat}",
        "source_dataset": "Hong Kong Housing Authority public rental housing stock + Address Lookup Service",
        "country": "HK",
        "admin1": bilingual(region_zh, region_en),
        "locality": bilingual(district_zh, f"{district_en} District"),
        "district": location,
        "postal_city": bilingual(district_zh, f"{district_en} District"),
        "address_levels": [bilingual(region_zh, region_en), bilingual(district_zh, f"{district_en} District"), location],
        "street": bilingual(address.get("street_chinese"), address.get("street_english")),
        "number": clean(address.get("number")),
        "building_name": bilingual(block_zh, address.get("building_english") or block_en),
        "unit": unit,
        "floor": floor,
        "estate_name": bilingual(estate_zh, address.get("estate_english") or estate_en),
        "longitude": longitude,
        "latitude": latitude,
        "property_type": "apartment",
        "residential_building_id": f"hk-als:{geo_address}",
        "residential_building_class": "apartments",
        "source_rank": hashlib.sha256(identity.encode("utf-8")).hexdigest(),
        "dedupe_key": f"ha:{geo_address}:{key(floor)}:{key(flat)}",
    }


def housing_rows(paths):
    for path in paths:
        with open(path, encoding="utf-8-sig") as source:
            payload = json.load(source)
        for row in payload.get("records", []):
            if isinstance(row, dict):
                yield row


def housing_records(paths, cache_file, offline=False, request_interval=0.2):
    cache = load_als_cache(cache_file)
    attempted = set()
    for row in housing_rows(paths):
        cache_id = als_cache_key(row)
        if cache_id not in cache or (cache[cache_id] is None and cache_id not in attempted):
            if offline:
                continue
            result = als_lookup(row)
            cache[cache_id] = result
            attempted.add(cache_id)
            if cache_file:
                os.makedirs(os.path.dirname(os.path.abspath(cache_file)), exist_ok=True)
                with open(cache_file, "a", encoding="utf-8", newline="\n") as output:
                    output.write(json.dumps({"key": cache_id, "result": result}, ensure_ascii=False, separators=(",", ":")) + "\n")
            time.sleep(request_interval)
        value = housing_candidate(row, cache.get(cache_id))
        if value:
            yield value


def select_balanced(values, maximum, per_district):
    deduplicated = {}
    for value in values:
        identity = value["dedupe_key"]
        existing = deduplicated.get(identity)
        if existing is None or value["source_rank"] < existing["source_rank"]:
            deduplicated[identity] = dict(value)
    buckets = defaultdict(list)
    for value in deduplicated.values():
        buckets[value["locality"]].append(value)
    queues = [deque(sorted(bucket, key=lambda value: value["source_rank"])[:per_district])
              for _, bucket in sorted(buckets.items())]
    selected = []
    while queues and len(selected) < maximum:
        remaining = []
        for queue in queues:
            if queue and len(selected) < maximum:
                value = queue.popleft()
                value.pop("source_rank", None)
                value.pop("dedupe_key", None)
                selected.append(value)
            if queue:
                remaining.append(queue)
        queues = remaining
    return selected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--building-information", action="append", default=[])
    parser.add_argument("--housing-json", action="append", default=[])
    parser.add_argument("--als-cache")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--request-interval", type=float, default=0.2)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-records", type=int, required=True)
    parser.add_argument("--per-district", type=int, required=True)
    args = parser.parse_args()
    if not args.building_information and not args.housing_json:
        parser.error("at least one official Hong Kong source is required")
    if args.housing_json and not args.als_cache:
        parser.error("--als-cache is required with --housing-json")
    values = private_records(args.building_information)
    if args.housing_json:
        values = list(values) + list(housing_records(
            args.housing_json, args.als_cache, args.offline, args.request_interval
        ))
    selected = select_balanced(values, args.max_records, args.per_district)
    with open(args.output, "w", encoding="utf-8", newline="\n") as output:
        for value in selected:
            output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
