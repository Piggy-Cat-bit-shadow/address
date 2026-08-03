import argparse
import csv
import hashlib
import io
import json
import math
import pathlib
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed

import duckdb
import osmium
from osmium.filter import KeyFilter
from shapely import from_wkb, intersects_xy, prepare


RESIDENTIAL_BUILDINGS = {
    "apartments", "bungalow", "cabin", "detached", "dormitory", "ger",
    "house", "residential", "semidetached_house", "terrace"
}
NON_RESIDENTIAL_KEYS = {
    "amenity", "craft", "healthcare", "industrial", "leisure", "military",
    "office", "public_transport", "shop", "tourism"
}
CHOME_PATTERN = re.compile(r"^(.+?)([一二三四五六七八九十百〇0-9]+丁目)(.*)$")
POSTAL_RANGE_PATTERN = re.compile(r"(\d+)[~〜～-](\d+)丁目")
POSTAL_SINGLE_PATTERN = re.compile(r"(?:^|[^\d])(\d+)丁目")
USER_AGENT = "address-sync/1.0 (+https://github.com/daimon3332/address)"


def clean(value):
    return unicodedata.normalize("NFKC", str(value or "")).strip().replace("ヶ", "ケ").replace("ヵ", "カ")


def rank(value):
    return int(hashlib.sha256(value.encode("utf-8")).hexdigest()[:15], 16)


def request_bytes(url, byte_limit=128 * 1024 * 1024):
    error = None
    for _ in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
            with urllib.request.urlopen(request, timeout=90) as response:
                payload = response.read(byte_limit + 1)
                if len(payload) > byte_limit:
                    raise RuntimeError(f"ABR response exceeds size limit: {url}")
                return payload
        except (OSError, urllib.error.HTTPError, urllib.error.URLError) as caught:
            error = caught
    if isinstance(error, urllib.error.HTTPError) and error.code == 404:
        return None
    raise RuntimeError(f"ABR request failed: {url}") from error


def request_json(url):
    payload = request_bytes(url)
    if payload is None:
        return None
    return json.loads(payload.decode("utf-8"))


def japanese_number(value):
    source = clean(value)
    if source.isdigit():
        return int(source)
    digits = {"〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9}
    if not source or any(character not in digits and character not in "十百" for character in source):
        return None
    total = 0
    pending = 0
    for character in source:
        if character in digits:
            pending = digits[character]
        elif character == "十":
            total += (pending or 1) * 10
            pending = 0
        elif character == "百":
            total += (pending or 1) * 100
            pending = 0
    return total + pending


def postal_key(prefecture, city, town):
    return clean(prefecture), clean(city), clean(town)


def load_postcodes(path):
    entries = {}
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        if len(names) != 1:
            raise RuntimeError("Japan Post archive must contain one CSV file")
        with archive.open(names[0]) as raw:
            reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            for row in reader:
                if len(row) < 9 or not re.fullmatch(r"\d{7}", row[2]):
                    continue
                prefecture, city, town = map(clean, row[6:9])
                if not prefecture or not city or not town or town == "以下に掲載がない場合":
                    continue
                base = town.split("(", 1)[0]
                if not base:
                    continue
                minimum = maximum = None
                range_match = POSTAL_RANGE_PATTERN.search(town)
                single_match = POSTAL_SINGLE_PATTERN.search(town)
                if range_match:
                    minimum, maximum = map(int, range_match.groups())
                elif single_match:
                    minimum = maximum = int(single_match.group(1))
                entries.setdefault(postal_key(prefecture, city, base), []).append((row[2], minimum, maximum))
    return entries


def postcode_for(entries, prefecture, city, district, chome_number):
    matches = entries.get(postal_key(prefecture, city, district), [])
    if not matches:
        return None
    ranged = {
        postcode for postcode, minimum, maximum in matches
        if minimum is not None and chome_number is not None and minimum <= chome_number <= maximum
    }
    if len(ranged) == 1:
        return ranged.pop()
    unrestricted = {postcode for postcode, minimum, _ in matches if minimum is None}
    if len(unrestricted) == 1:
        return unrestricted.pop()
    all_postcodes = {postcode for postcode, _, _ in matches}
    return all_postcodes.pop() if len(all_postcodes) == 1 else None


def city_name(city):
    return f"{city.get('county', '')}{city.get('city', '')}{city.get('ward', '')}"


def parse_city(args):
    base_url, prefecture, city, postcodes, city_limit = args
    encoded_prefecture = urllib.parse.quote(prefecture, safe="")
    encoded_city = urllib.parse.quote(city, safe="")
    url = f"{base_url}/{encoded_prefecture}/{encoded_city}-%E4%BD%8F%E5%B1%85%E8%A1%A8%E7%A4%BA.txt"
    payload = request_bytes(url)
    if payload is None:
        return []
    text = payload.decode("utf-8")
    candidates = []
    for section in text.split("住居表示,")[1:]:
        lines = section.splitlines()
        if len(lines) < 3:
            continue
        street = clean(lines[0])
        match = CHOME_PATTERN.match(street)
        if not match:
            continue
        district, chome, suffix = match.groups()
        district = clean(f"{district}{suffix}")
        chome_number = japanese_number(chome[:-2])
        postcode = postcode_for(postcodes, prefecture, city, district, chome_number)
        if not district or district == street or not postcode:
            continue
        reader = csv.DictReader(lines[1:])
        for row in reader:
            block = clean(row.get("blk_num"))
            residence = clean(row.get("rsdt_num"))
            residence2 = clean(row.get("rsdt_num2"))
            try:
                longitude = float(row.get("lng", ""))
                latitude = float(row.get("lat", ""))
            except ValueError:
                continue
            if not block or not residence or not (122 <= longitude <= 154 and 20 <= latitude <= 46):
                continue
            number = f"{block}番{residence}{f'-{residence2}' if residence2 else ''}号"
            identity = f"{prefecture}\x1f{city}\x1f{street}\x1f{number}\x1f{longitude:.9f}\x1f{latitude:.9f}"
            candidates.append({
                "source_id": f"abr/{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]}",
                "prefecture": prefecture,
                "city": city,
                "district": district,
                "street": street,
                "number": number,
                "postcode": postcode,
                "longitude": longitude,
                "latitude": latitude,
                "source_rank": rank(identity)
            })
    candidates.sort(key=lambda candidate: (candidate["source_rank"], candidate["source_id"]))
    return candidates if city_limit is None else candidates[:city_limit]


def lot_city_matches(plateau_code, city_code, has_ward):
    if not plateau_code or not city_code:
        return False
    if city_code == plateau_code:
        return True
    if not has_ward or not plateau_code.endswith("0"):
        return False
    base = int(plateau_code)
    return base < int(city_code) <= base + 30


def parse_lot_sections(text, prefecture, city, postcodes):
    lots = []
    seen = set()
    for section in text.split("地番,")[1:]:
        lines = section.splitlines()
        if len(lines) < 3:
            continue
        town = clean(lines[0])
        if not town:
            continue
        district = ""
        chome_number = None
        match = CHOME_PATTERN.match(town)
        if match:
            base, chome, suffix = match.groups()
            candidate_district = clean(f"{base}{suffix}")
            if candidate_district and candidate_district != town:
                district = candidate_district
                chome_number = japanese_number(chome[:-2])
        postcode = postcode_for(postcodes, prefecture, city, district or town, chome_number)
        for row in csv.DictReader(lines[1:]):
            lot1 = clean(row.get("prc_num1"))
            lot2 = clean(row.get("prc_num2"))
            if not lot1.isdigit() or (lot2 and not lot2.isdigit()) or clean(row.get("prc_num3")):
                continue
            try:
                longitude = float(row.get("lng") or "")
                latitude = float(row.get("lat") or "")
            except ValueError:
                continue
            if not (122 <= longitude <= 154 and 20 <= latitude <= 46):
                continue
            number = f"{lot1}番地{lot2}" if lot2 else f"{lot1}番地"
            if (town, number) in seen:
                continue
            seen.add((town, number))
            identity = f"{prefecture}\x1f{city}\x1f{town}\x1f{number}\x1f{longitude:.9f}\x1f{latitude:.9f}"
            lots.append({
                "source_id": f"chiban/{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]}",
                "prefecture": prefecture,
                "city": city,
                "district": district,
                "street": town,
                "number": number,
                "postcode": postcode,
                "longitude": longitude,
                "latitude": latitude,
                "source_rank": rank(identity)
            })
    return lots


def iter_parquet_buildings(parquet_path):
    database = duckdb.connect()
    try:
        cursor = database.execute(
            "SELECT building_uid,usage,geometry FROM read_parquet(?)", [str(parquet_path)]
        )
        while rows := cursor.fetchmany(2_000):
            yield from rows
    finally:
        database.close()


def match_city_lots(connection, lots, buildings, claimed_buildings):
    store = duckdb.connect()
    store.execute("""
        CREATE TABLE lots (
            id INTEGER PRIMARY KEY, residential_matches INTEGER NOT NULL DEFAULT 0,
            blocked_matches INTEGER NOT NULL DEFAULT 0, building_uid TEXT,
            longitude REAL NOT NULL, latitude REAL NOT NULL
        )
    """)
    counts = {"lots": len(lots), "in_unique_building": 0, "building_unique": 0,
              "unclaimed": 0, "inserted": 0}
    building_lot_counts = {}
    try:
        for index, lot in enumerate(lots):
            store.execute("INSERT INTO lots(id,longitude,latitude) VALUES (?,?,?)", (
                index, lot["longitude"], lot["latitude"]
            ))
        for building_uid, usage, geometry_wkb in buildings:
            if not building_uid or not geometry_wkb:
                continue
            try:
                geometry = from_wkb(geometry_wkb)
            except Exception:
                continue
            if geometry.is_empty:
                continue
            minimum_longitude, minimum_latitude, maximum_longitude, maximum_latitude = geometry.bounds
            rows = store.execute("""
                SELECT id FROM lots WHERE longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ?
            """, (minimum_longitude, maximum_longitude, minimum_latitude, maximum_latitude)).fetchall()
            if not rows:
                continue
            residential = clean(usage).casefold() == "residential"
            prepare(geometry)
            for (lot_id,) in rows:
                lot = lots[lot_id]
                if not intersects_xy(geometry, lot["longitude"], lot["latitude"]):
                    continue
                if residential:
                    building_lot_counts[building_uid] = building_lot_counts.get(building_uid, 0) + 1
                    store.execute(
                        "UPDATE lots SET residential_matches=residential_matches+1, building_uid=? WHERE id=?",
                        (building_uid, lot_id))
                else:
                    store.execute("UPDATE lots SET blocked_matches=blocked_matches+1 WHERE id=?", (lot_id,))
        matched = store.execute(
            "SELECT id, building_uid FROM lots WHERE residential_matches=1 AND blocked_matches=0 ORDER BY id"
        ).fetchall()
    finally:
        store.close()
    counts["in_unique_building"] = len(matched)
    for lot_id, building_uid in matched:
        if building_lot_counts.get(building_uid) != 1:
            continue
        counts["building_unique"] += 1
        building_id = f"plateau/{building_uid}"
        if building_id in claimed_buildings:
            continue
        counts["unclaimed"] += 1
        lot = lots[lot_id]
        if not lot["postcode"]:
            continue
        claimed_buildings.add(building_id)
        connection.execute("""
            INSERT INTO candidates(source_id,prefecture,city,district,street,number,postcode,
              longitude,latitude,source_rank,building_id,building_class,building_name)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (lot["source_id"], lot["prefecture"], lot["city"], lot["district"], lot["street"],
              lot["number"], lot["postcode"], lot["longitude"], lot["latitude"], lot["source_rank"],
              building_id, "residential", ""))
        counts["inserted"] += 1
    return counts


def export_land_lots(connection, cities, plateau_bundles, base_url, postcodes):
    claimed = {row[0] for row in connection.execute(
        "SELECT DISTINCT building_id FROM candidates WHERE building_id LIKE 'plateau/%'"
    ).fetchall()}
    inserted_total = 0
    for city_code, parquet_path in plateau_bundles:
        lots = []
        for prefecture, city, code, has_ward in cities:
            if not lot_city_matches(city_code, code, has_ward):
                continue
            encoded_prefecture = urllib.parse.quote(prefecture, safe="")
            encoded_city = urllib.parse.quote(city, safe="")
            payload = request_bytes(f"{base_url}/{encoded_prefecture}/{encoded_city}-%E5%9C%B0%E7%95%AA.txt")
            if payload is None:
                continue
            lots.extend(parse_lot_sections(payload.decode("utf-8"), prefecture, city, postcodes))
        if not lots:
            continue
        counts = match_city_lots(connection, lots, iter_parquet_buildings(parquet_path), claimed)
        inserted_total += counts["inserted"]
        print("Japan land-lot " + city_code + ": "
              + " ".join(f"{key}={value}" for key, value in counts.items()),
              file=sys.stderr, flush=True)
    return inserted_total


def point_in_ring(longitude, latitude, ring):
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = previous
        x2, y2 = current
        if (y1 > latitude) != (y2 > latitude):
            crossing = (x2 - x1) * (latitude - y1) / (y2 - y1) + x1
            if longitude < crossing:
                inside = not inside
        previous = current
    return inside


def open_candidate_store(path):
    connection = duckdb.connect(str(path))
    connection.execute("CREATE SEQUENCE candidate_id START 1")
    connection.execute("""
        CREATE TABLE candidates (
            id BIGINT PRIMARY KEY DEFAULT nextval('candidate_id'), source_id TEXT NOT NULL, prefecture TEXT NOT NULL,
            city TEXT NOT NULL, district TEXT NOT NULL, street TEXT NOT NULL,
            number TEXT NOT NULL, postcode TEXT NOT NULL, longitude REAL NOT NULL,
            latitude REAL NOT NULL, source_rank BIGINT NOT NULL,
            building_id TEXT, building_class TEXT, building_name TEXT
        )
    """)
    connection.execute("CREATE INDEX candidate_coordinates ON candidates(longitude, latitude)")
    return connection


def insert_candidates(connection, candidates):
    for candidate in candidates:
        connection.execute("""
            INSERT INTO candidates(source_id,prefecture,city,district,street,number,postcode,
              longitude,latitude,source_rank) VALUES (?,?,?,?,?,?,?,?,?,?)
        """, tuple(candidate[field] for field in (
            "source_id", "prefecture", "city", "district", "street", "number", "postcode",
            "longitude", "latitude", "source_rank"
        )))


def match_residential_buildings(connection, osm_path, output_path):
    location_index = None
    location_storage = "flex_mem"
    if pathlib.Path(osm_path).stat().st_size >= 1_000_000_000:
        location_index = pathlib.Path(output_path).with_suffix(pathlib.Path(output_path).suffix + ".locations.idx")
        location_index.unlink(missing_ok=True)
        location_storage = f"sparse_file_array,{location_index}"
    processor = osmium.FileProcessor(osm_path).with_locations(location_storage).with_filter(
        KeyFilter("building", *NON_RESIDENTIAL_KEYS)
    )
    processed_ways = 0
    try:
        for entity in processor:
            if not entity.is_way():
                continue
            processed_ways += 1
            if processed_ways % 1_000_000 == 0:
                matched = connection.execute("SELECT COUNT(*) FROM candidates WHERE building_id IS NOT NULL").fetchone()[0]
                print(f"Japan OSM residential scan: {processed_ways} ways, {matched} matches", file=sys.stderr, flush=True)
            tags = {tag.k: tag.v for tag in entity.tags}
            building_class = clean(tags.get("building")).casefold()
            if building_class not in RESIDENTIAL_BUILDINGS or any(clean(tags.get(key)) not in {"", "no", "none"}
                                                                   for key in NON_RESIDENTIAL_KEYS):
                continue
            locations = [node.location for node in entity.nodes]
            if len(locations) < 4 or not all(location.valid() for location in locations):
                continue
            ring = [(location.lon, location.lat) for location in locations]
            if ring[0] != ring[-1]:
                continue
            longitudes = [point[0] for point in ring]
            latitudes = [point[1] for point in ring]
            rows = connection.execute("""
                SELECT id,longitude,latitude FROM candidates
                WHERE building_id IS NULL AND longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ?
            """, (min(longitudes), max(longitudes), min(latitudes), max(latitudes))).fetchall()
            for candidate_id, longitude, latitude in rows:
                if point_in_ring(longitude, latitude, ring):
                    connection.execute(
                        "UPDATE candidates SET building_id=?,building_class=?,building_name=? "
                        "WHERE id=? AND building_id IS NULL",
                        (f"way/{entity.id}", building_class, clean(tags.get("name")), candidate_id)
                    )
    finally:
        del processor
        if location_index:
            location_index.unlink(missing_ok=True)


def match_plateau_buildings(connection, parquet_paths):
    matched_total = 0
    for parquet_path in parquet_paths:
        database = duckdb.connect()
        try:
            cursor = database.execute(
                "SELECT building_uid,geometry FROM read_parquet(?) WHERE usage='residential'",
                [str(parquet_path)]
            )
            processed = 0
            while rows := cursor.fetchmany(2_000):
                for building_uid, geometry_wkb in rows:
                    processed += 1
                    if not building_uid or not geometry_wkb:
                        continue
                    try:
                        geometry = from_wkb(geometry_wkb)
                    except Exception:
                        continue
                    if geometry.is_empty:
                        continue
                    minimum_longitude, minimum_latitude, maximum_longitude, maximum_latitude = geometry.bounds
                    candidates = connection.execute("""
                        SELECT id,longitude,latitude FROM candidates
                        WHERE building_id IS NULL AND longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ?
                    """, (minimum_longitude, maximum_longitude, minimum_latitude, maximum_latitude)).fetchall()
                    if not candidates:
                        continue
                    prepare(geometry)
                    for candidate_id, longitude, latitude in candidates:
                        if intersects_xy(geometry, longitude, latitude):
                            connection.execute(
                                "UPDATE candidates SET building_id=?,building_class=? "
                                "WHERE id=? AND building_id IS NULL",
                                (f"plateau/{building_uid}", "residential", candidate_id)
                            )
                            matched_total += 1
                if processed % 100_000 == 0:
                    print(f"Japan PLATEAU residential scan: {processed} buildings, {matched_total} matches",
                          file=sys.stderr, flush=True)
        finally:
            database.close()
    return matched_total


def select_records(connection, max_records, per_locality):
    rows = connection.execute("""
        SELECT source_id,prefecture,city,district,street,number,postcode,longitude,latitude,
               source_rank,building_id,building_class,building_name
        FROM candidates WHERE building_id IS NOT NULL ORDER BY city,source_rank,source_id
    """).fetchall()
    groups = {}
    for row in rows:
        groups.setdefault((row[1], row[2]), []).append(row)
    ordered = sorted(groups)
    positions = {key: 0 for key in ordered}
    prefecture_counts = {}
    prefecture_cap = math.ceil(max_records * 0.15)
    group_limit = min(per_locality, max_records)
    selected = []
    overflow = False
    while len(selected) < max_records:
        added = deferred = False
        for key in ordered:
            values = groups[key]
            position = positions[key]
            if position >= min(len(values), group_limit):
                continue
            if not overflow and prefecture_counts.get(key[0], 0) >= prefecture_cap:
                deferred = True
                continue
            selected.append(values[position])
            positions[key] = position + 1
            prefecture_counts[key[0]] = prefecture_counts.get(key[0], 0) + 1
            added = True
            if len(selected) == max_records:
                break
        if not added:
            if not deferred:
                break
            overflow = True
    return selected


def write_records(path, rows):
    with pathlib.Path(path).open("w", encoding="utf-8", newline="\n") as output:
        for row in rows:
            source_id, prefecture, city, district, street, number, postcode, longitude, latitude, _, building_id, building_class, building_name = row
            output.write(json.dumps({
                "id": source_id,
                "source_record_id": source_id,
                "source_dataset": "Digital Agency Address Base Registry via Geolonia",
                "address_levels": [prefecture, city, district],
                "postal_city": city,
                "postcode": postcode,
                "street": street,
                "number": number,
                "longitude": longitude,
                "latitude": latitude,
                "property_type": "apartment" if building_class == "apartments" else "residential",
                "residential_building_id": building_id,
                "residential_building_class": building_class,
                "building_name": building_name
            }, ensure_ascii=False, separators=(",", ":")) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--abr-url", required=True)
    parser.add_argument("--postal-zip", required=True)
    parser.add_argument("--osm-pbf")
    parser.add_argument("--plateau-parquet", action="append", default=[])
    parser.add_argument("--plateau-city-code", action="append", default=[])
    parser.add_argument("--land-lot", action="store_true")
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-records", required=True, type=int)
    parser.add_argument("--per-locality", required=True, type=int)
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()

    root = request_json(args.abr_url)
    if not isinstance(root, dict) or not isinstance(root.get("data"), list):
        raise RuntimeError("Geolonia ABR root response is invalid")
    cities = [(prefecture["pref"], city_name(city), str(city.get("code", "")).zfill(6)[:5],
               bool(clean(city.get("ward"))))
              for prefecture in root["data"] for city in prefecture.get("cities", [])]
    cities = [entry for entry in cities if entry[0] and entry[1]]
    if not cities:
        raise RuntimeError("Geolonia ABR root contains no cities")
    postcodes = load_postcodes(args.postal_zip)
    city_limit = max(200, math.ceil(args.max_records * 48 / len(cities)))
    base_url = f"{args.abr_url.rsplit('/', 1)[0]}/ja"
    store_path = pathlib.Path(args.output).with_suffix(pathlib.Path(args.output).suffix + ".candidates.duckdb")
    store_path.unlink(missing_ok=True)
    connection = open_candidate_store(store_path)
    try:
        with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 32))) as executor:
            priority_codes = set(args.plateau_city_code)
            futures = [executor.submit(parse_city, (
                base_url, prefecture, city, postcodes,
                None if any(lot_city_matches(priority, code, has_ward) for priority in priority_codes)
                else city_limit
            )) for prefecture, city, code, has_ward in cities]
            failures = 0
            for completed, future in enumerate(as_completed(futures), start=1):
                try:
                    insert_candidates(connection, future.result())
                except RuntimeError as error:
                    failures += 1
                    print(str(error), file=sys.stderr, flush=True)
                if completed % 100 == 0 or completed == len(futures):
                    count = connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
                    print(f"Japan ABR preparation: {completed}/{len(futures)} cities, {count} candidates",
                          file=sys.stderr, flush=True)
            if failures > max(10, math.floor(len(cities) * 0.1)):
                raise RuntimeError(f"ABR city preparation failed for {failures}/{len(cities)} cities")
        connection.commit()
        candidate_count = connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
        if candidate_count == 0:
            raise RuntimeError("ABR and Japan Post produced no strict address candidates")
        if args.plateau_parquet:
            matched = match_plateau_buildings(connection, args.plateau_parquet)
            print(f"Japan PLATEAU residential matches: {matched}", file=sys.stderr, flush=True)
        if args.osm_pbf:
            match_residential_buildings(connection, args.osm_pbf, args.output)
        connection.commit()
        if args.land_lot and args.plateau_parquet:
            land_lot_bundles = list(zip(args.plateau_city_code, args.plateau_parquet))
            inserted = export_land_lots(connection, cities, land_lot_bundles, base_url, postcodes)
            print(f"Japan land-lot residential additions: {inserted}", file=sys.stderr, flush=True)
            connection.commit()
        selected = select_records(connection, args.max_records, args.per_locality)
        if not selected:
            raise RuntimeError("No ABR address point intersects an explicit residential building")
        write_records(args.output, selected)
    finally:
        connection.close()
        store_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
