import argparse
import csv
import hashlib
import heapq
import io
import json
import math
import os
import pathlib
import re
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

import duckdb
import osmium
from osmium.filter import KeyFilter
from shapely import Polygon, STRtree, from_wkb, points


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
DUCKDB_MEMORY_LIMIT = os.environ.get("JAPAN_DUCKDB_MEMORY_LIMIT", "4GB").strip() or "4GB"
LAND_LOT_INSERT_BATCH = 500
ABR_INSERT_BATCH = 2_000


def load_checkpoint(path):
    checkpoint_path = pathlib.Path(path)
    if not checkpoint_path.exists():
        return {"version": 1, "abr_complete": False, "abr_completed_cities": [], "plateau_completed": [],
                "osm_scanned_ways": 0, "osm_complete": False, "final_complete": False}
    with checkpoint_path.open(encoding="utf-8") as source:
        checkpoint = json.load(source)
    if checkpoint.get("version") != 1:
        raise RuntimeError("Japan materialization checkpoint version is unsupported")
    checkpoint.setdefault("plateau_completed", [])
    checkpoint.setdefault("plateau_building_completed", [])
    checkpoint.setdefault("abr_completed_cities", [])
    checkpoint.setdefault("osm_scanned_ways", 0)
    checkpoint.setdefault("osm_complete", False)
    checkpoint.setdefault("final_complete", False)
    return checkpoint


def write_checkpoint(path, checkpoint):
    checkpoint_path = pathlib.Path(path)
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = checkpoint_path.with_name(f"{checkpoint_path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(checkpoint, output, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(checkpoint_path)


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
    seen_source_ids = set()
    candidate_index = 0
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
            candidate = {
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
            }
            if candidate["source_id"] in seen_source_ids:
                continue
            seen_source_ids.add(candidate["source_id"])
            if city_limit is None:
                candidates.append(candidate)
                continue
            candidate_index += 1
            source_order = int(candidate["source_id"].split("/", 1)[1], 16)
            item = (-candidate["source_rank"], -source_order, -candidate_index, candidate)
            if len(candidates) < city_limit:
                heapq.heappush(candidates, item)
            elif item > candidates[0]:
                heapq.heapreplace(candidates, item)
    selected = candidates if city_limit is None else [item[3] for item in candidates]
    selected.sort(key=lambda candidate: (candidate["source_rank"], candidate["source_id"]))
    return selected


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


def duckdb_spill_path(path):
    if str(path) == ":memory:":
        return pathlib.Path(tempfile.gettempdir()) / f"japan-{os.getpid()}.duckdb.tmp"
    return pathlib.Path(f"{path}.tmp")


def configure_duckdb(connection, spill_path):
    connection.execute("SET threads=2")
    connection.execute("SET preserve_insertion_order=false")
    connection.execute("SET memory_limit=?", [DUCKDB_MEMORY_LIMIT])
    connection.execute("SET temp_directory=?", [str(spill_path)])


def iter_parquet_buildings(parquet_path):
    database = duckdb.connect()
    try:
        configure_duckdb(database, duckdb_spill_path(parquet_path))
        cursor = database.execute(
            "SELECT building_uid,usage,geometry FROM read_parquet(?)", [str(parquet_path)]
        )
        while rows := cursor.fetchmany(2_000):
            yield from rows
    finally:
        database.close()


def insert_land_lot_candidates(connection, candidates, batch_size=LAND_LOT_INSERT_BATCH, progress=None):
    existing_ids = {row[0] for row in connection.execute(
        "SELECT source_id FROM candidates WHERE source_id LIKE 'chiban/%'"
    ).fetchall()}
    seen_ids = set(existing_ids)
    pending = []
    for candidate in candidates:
        if candidate[0] in seen_ids:
            continue
        seen_ids.add(candidate[0])
        pending.append(candidate)
    committed_count = len(existing_ids)
    for offset in range(0, len(pending), batch_size):
        batch = pending[offset:offset + batch_size]
        connection.execute("BEGIN TRANSACTION")
        try:
            connection.executemany("""
                INSERT INTO candidates(source_id,prefecture,city,district,street,number,postcode,
                  longitude,latitude,source_rank,building_id,building_class,building_name)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, batch)
            connection.commit()
            committed_count += len(batch)
            if progress:
                progress(committed_count)
        except Exception:
            connection.rollback()
            raise
    return len(pending)


def match_city_lots(connection, lots, buildings, claimed_buildings, progress=None):
    counts = {"lots": len(lots), "in_unique_building": 0, "building_unique": 0,
              "unclaimed": 0, "inserted": 0}
    if not lots:
        return counts
    tree = STRtree(points([lot["longitude"] for lot in lots], [lot["latitude"] for lot in lots]))
    residential_matches = [0] * len(lots)
    blocked_matches = [0] * len(lots)
    lot_buildings = [None] * len(lots)
    building_lot_counts = {}
    batch = []

    def match_batch():
        if not batch:
            return
        geometries = [entry[2] for entry in batch]
        pairs = tree.query(geometries, predicate="contains")
        for building_index, lot_id in zip(pairs[0].tolist(), pairs[1].tolist()):
            building_uid, residential, _ = batch[building_index]
            if residential:
                residential_matches[lot_id] += 1
                lot_buildings[lot_id] = building_uid
                building_lot_counts[building_uid] = building_lot_counts.get(building_uid, 0) + 1
            else:
                blocked_matches[lot_id] += 1
        batch.clear()

    for building_uid, usage, geometry_wkb in buildings:
        if not building_uid or not geometry_wkb:
            continue
        try:
            geometry = from_wkb(geometry_wkb)
        except Exception:
            continue
        if geometry.is_empty:
            continue
        batch.append((building_uid, clean(usage).casefold() == "residential", geometry))
        if len(batch) >= 5_000:
            match_batch()
    match_batch()
    matched = [(lot_id, lot_buildings[lot_id]) for lot_id in range(len(lots))
               if residential_matches[lot_id] == 1 and blocked_matches[lot_id] == 0]
    counts["in_unique_building"] = len(matched)
    candidates = []
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
        candidates.append((
            lot["source_id"], lot["prefecture"], lot["city"], lot["district"], lot["street"],
            lot["number"], lot["postcode"], lot["longitude"], lot["latitude"], lot["source_rank"],
            building_id, "residential", ""
        ))
    counts["inserted"] = insert_land_lot_candidates(connection, candidates, progress=progress)
    return counts


def export_land_lots(connection, cities, plateau_bundles, base_url, postcodes, progress=None):
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
        counts = match_city_lots(connection, lots, iter_parquet_buildings(parquet_path), claimed, progress)
        inserted_total += counts["inserted"]
        print("Japan land-lot " + city_code + ": "
              + " ".join(f"{key}={value}" for key, value in counts.items()),
              file=sys.stderr, flush=True)
    return inserted_total


def open_candidate_store(path):
    connection = duckdb.connect(str(path))
    configure_duckdb(connection, duckdb_spill_path(path))
    connection.execute("CREATE SEQUENCE IF NOT EXISTS candidate_id START 1")
    connection.execute("""
        CREATE TABLE IF NOT EXISTS candidates (
            id BIGINT PRIMARY KEY DEFAULT nextval('candidate_id'), source_id TEXT NOT NULL, prefecture TEXT NOT NULL,
            city TEXT NOT NULL, district TEXT NOT NULL, street TEXT NOT NULL,
            number TEXT NOT NULL, postcode TEXT NOT NULL, longitude REAL NOT NULL,
            latitude REAL NOT NULL, source_rank BIGINT NOT NULL,
            building_id TEXT, building_class TEXT, building_name TEXT
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS abr_city_commits (
            city_key TEXT PRIMARY KEY
        )
    """)
    return connection


def insert_candidates(connection, candidates):
    fields = (
        "source_id", "prefecture", "city", "district", "street", "number", "postcode",
        "longitude", "latitude", "source_rank"
    )
    for offset in range(0, len(candidates), ABR_INSERT_BATCH):
        connection.executemany("""
            INSERT INTO candidates(source_id,prefecture,city,district,street,number,postcode,
              longitude,latitude,source_rank) VALUES (?,?,?,?,?,?,?,?,?,?)
        """, [tuple(candidate[field] for field in fields)
              for candidate in candidates[offset:offset + ABR_INSERT_BATCH]])


def insert_city_candidates(connection, identity, candidates):
    prefecture, city, city_code = identity
    connection.execute(
        "DELETE FROM candidates WHERE source_id LIKE 'abr/%' AND prefecture=? AND city=?",
        [prefecture, city]
    )
    insert_candidates(connection, candidates)
    connection.execute(
        "INSERT INTO abr_city_commits(city_key) VALUES (?) ON CONFLICT(city_key) DO NOTHING",
        [f"{city_code}\x1f{prefecture}\x1f{city}"]
    )


class CandidatePointIndex:
    def __init__(self, connection):
        rows = connection.execute(
            "SELECT id,longitude,latitude FROM candidates WHERE building_id IS NULL ORDER BY id"
        ).fetchall()
        self.candidate_ids = [row[0] for row in rows]
        self.tree = STRtree(points([row[1] for row in rows], [row[2] for row in rows])) if rows else None
        self.claimed = set()

    def match(self, geometries, building_ids, building_classes, building_names=None):
        if self.tree is None or not geometries:
            return []
        pairs = self.tree.query(geometries, predicate="contains")
        selected = {}
        for geometry_index, candidate_index in zip(pairs[0].tolist(), pairs[1].tolist()):
            if candidate_index in self.claimed:
                continue
            current = selected.get(candidate_index)
            if current is None or geometry_index < current:
                selected[candidate_index] = geometry_index
        updates = []
        for candidate_index, geometry_index in sorted(selected.items()):
            self.claimed.add(candidate_index)
            updates.append((
                building_ids[geometry_index], building_classes[geometry_index],
                building_names[geometry_index] if building_names else "",
                self.candidate_ids[candidate_index]
            ))
        return updates


def match_residential_buildings(connection, osm_path, output_path, start_way=0, progress=None):
    location_index = None
    location_storage = "flex_mem"
    if pathlib.Path(osm_path).stat().st_size >= 1_000_000_000:
        location_index = pathlib.Path(output_path).with_suffix(pathlib.Path(output_path).suffix + ".locations.idx")
        location_index.unlink(missing_ok=True)
        location_storage = f"sparse_file_array,{location_index}"
    processor = osmium.FileProcessor(osm_path).with_locations(location_storage).with_filter(
        KeyFilter("building", *NON_RESIDENTIAL_KEYS)
    )
    candidate_index = CandidatePointIndex(connection)
    processed_ways = 0
    matched_total = 0
    pending_updates = []

    def flush(scanned_ways=None):
        nonlocal matched_total, pending_updates
        if pending_updates:
            connection.executemany(
                "UPDATE candidates SET building_id=?,building_class=?,building_name=? "
                "WHERE id=? AND building_id IS NULL", pending_updates)
            matched_total += len(pending_updates)
            pending_updates = []
        connection.commit()
        if progress:
            progress(processed_ways if scanned_ways is None else scanned_ways, matched_total)

    try:
        for entity in processor:
            if not entity.is_way():
                continue
            processed_ways += 1
            if processed_ways <= start_way:
                continue
            if processed_ways % 100_000 == 0:
                flush(processed_ways - 1)
                print(f"Japan OSM residential scan: {processed_ways} ways, {matched_total} new matches",
                      file=sys.stderr, flush=True)
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
            geometry = Polygon(ring)
            if geometry.is_empty or not geometry.is_valid:
                continue
            pending_updates.extend(candidate_index.match(
                [geometry], [f"way/{entity.id}"], [building_class], [clean(tags.get("name"))]
            ))
            if len(pending_updates) >= 5_000:
                flush()
        flush()
    finally:
        del processor
        if location_index:
            location_index.unlink(missing_ok=True)
    return matched_total, processed_ways


def match_plateau_buildings(connection, parquet_path, start_offset=0, progress=None):
    candidate_index = CandidatePointIndex(connection)
    matched_total = 0
    processed = start_offset
    database = duckdb.connect()
    try:
        configure_duckdb(database, duckdb_spill_path(parquet_path))
        cursor = database.execute(
            "SELECT building_uid,geometry FROM read_parquet(?) WHERE usage='residential' OFFSET ?",
            [str(parquet_path), start_offset]
        )
        while rows := cursor.fetchmany(10_000):
            geometries = []
            building_ids = []
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
                geometries.append(geometry)
                building_ids.append(f"plateau/{building_uid}")
            updates = candidate_index.match(
                geometries, building_ids, ["residential"] * len(building_ids)
            )
            if updates:
                connection.executemany(
                    "UPDATE candidates SET building_id=?,building_class=?,building_name=? "
                    "WHERE id=? AND building_id IS NULL", updates)
                matched_total += len(updates)
            connection.commit()
            if progress:
                progress(processed, matched_total)
            if processed % 100_000 < len(rows):
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
    parser.add_argument("--stage", required=True, choices=("abr", "plateau", "osm", "final"))
    parser.add_argument("--abr-url")
    parser.add_argument("--postal-zip")
    parser.add_argument("--osm-pbf")
    parser.add_argument("--plateau-parquet", action="append", default=[])
    parser.add_argument("--plateau-city-code", action="append", default=[])
    parser.add_argument("--land-lot", action="store_true")
    parser.add_argument("--output", required=True)
    parser.add_argument("--checkpoint-file", required=True)
    parser.add_argument("--store-file", required=True)
    parser.add_argument("--max-records", required=True, type=int)
    parser.add_argument("--candidate-budget", required=True, type=int)
    parser.add_argument("--per-locality", required=True, type=int)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    checkpoint = load_checkpoint(args.checkpoint_file)
    store_path = pathlib.Path(args.store_file)
    store_path.parent.mkdir(parents=True, exist_ok=True)
    if checkpoint.get("abr_complete") and not store_path.exists():
        checkpoint = {"version": 1, "abr_complete": False, "abr_completed_cities": [], "plateau_completed": [],
                      "plateau_building_completed": [],
                      "osm_scanned_ways": 0, "osm_complete": False, "final_complete": False}
        write_checkpoint(args.checkpoint_file, checkpoint)
    if args.stage != "abr" and not checkpoint.get("abr_complete"):
        raise RuntimeError("Japan ABR candidate checkpoint must complete before this stage")
    connection = open_candidate_store(store_path)
    try:
        if args.stage == "abr" and not checkpoint.get("abr_complete"):
            if not args.abr_url or not args.postal_zip:
                raise RuntimeError("Japan ABR preparation requires the ABR catalog and Japan Post archive")
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
            city_limit = max(200, math.ceil(args.candidate_budget * 48 / len(cities)))
            base_url = f"{args.abr_url.rsplit('/', 1)[0]}/ja"
            committed_cities = {row[0] for row in connection.execute(
                "SELECT city_key FROM abr_city_commits"
            ).fetchall()}
            completed_cities = set(checkpoint.get("abr_completed_cities", [])) | committed_cities
            attempts = {key: int(value) for key, value in checkpoint.get("abr_attempts", {}).items()}
            pending_cities = [entry for entry in cities
                              if f"{entry[2]}\x1f{entry[0]}\x1f{entry[1]}" not in completed_cities]
            terminal = [entry for entry in pending_cities
                        if attempts.get(f"{entry[2]}\x1f{entry[0]}\x1f{entry[1]}", 0) >= 3]
            if terminal:
                raise RuntimeError(f"ABR city preparation stopped after three failures for {len(terminal)} cities")
            worker_count = max(1, min(args.workers, 8))
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                priority_codes = set(args.plateau_city_code)
                for offset in range(0, len(pending_cities), worker_count):
                    batch = pending_cities[offset:offset + worker_count]
                    futures = []
                    for prefecture, city, code, has_ward in batch:
                        futures.append((
                            (prefecture, city, code),
                            executor.submit(parse_city, (
                                base_url, prefecture, city, postcodes,
                                max(city_limit, 2_000)
                                if any(lot_city_matches(priority, code, has_ward) for priority in priority_codes)
                                else city_limit
                            ))
                        ))
                    results = []
                    for (prefecture, city, code), future in futures:
                        identity = f"{code}\x1f{prefecture}\x1f{city}"
                        try:
                            results.append((identity, future.result()))
                            attempts.pop(identity, None)
                        except RuntimeError as error:
                            attempts[identity] = attempts.get(identity, 0) + 1
                            print(str(error), file=sys.stderr, flush=True)
                    for identity, result in results:
                        city_code, prefecture, city = identity.split("\x1f")
                        insert_city_candidates(connection, (prefecture, city, city_code), result)
                        completed_cities.add(identity)
                        checkpoint["abr_completed_cities"] = sorted(completed_cities)
                        checkpoint["abr_attempts"] = attempts
                        checkpoint["candidate_count"] = connection.execute(
                            "SELECT COUNT(*) FROM candidates"
                        ).fetchone()[0]
                        write_checkpoint(args.checkpoint_file, checkpoint)
                    print(f"Japan ABR preparation: {len(completed_cities)}/{len(cities)} cities, "
                          f"{checkpoint['candidate_count']} candidates", file=sys.stderr, flush=True)
            if len(completed_cities) != len(cities):
                return
            checkpoint["abr_complete"] = True
            write_checkpoint(args.checkpoint_file, checkpoint)
            return
        candidate_count = connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
        if candidate_count == 0:
            raise RuntimeError("ABR and Japan Post produced no strict address candidates")
        if args.stage == "plateau":
            if len(args.plateau_city_code) != 1 or len(args.plateau_parquet) != 1:
                raise RuntimeError("Japan PLATEAU stage requires exactly one city bundle")
            city_code, parquet_path = args.plateau_city_code[0], args.plateau_parquet[0]
            completed_bundles = set(checkpoint.get("plateau_completed", []))
            if city_code in completed_bundles:
                return
            if not args.abr_url or not args.postal_zip:
                raise RuntimeError("Japan land-lot matching requires the ABR catalog and Japan Post archive")
            root = request_json(args.abr_url)
            cities = [(prefecture["pref"], city_name(city), str(city.get("code", "")).zfill(6)[:5],
                       bool(clean(city.get("ward"))))
                      for prefecture in root.get("data", []) for city in prefecture.get("cities", [])]
            postcodes = load_postcodes(args.postal_zip)
            base_url = f"{args.abr_url.rsplit('/', 1)[0]}/ja"
            plateau_offsets = checkpoint.setdefault("plateau_offsets", {})
            plateau_match_totals = checkpoint.setdefault("plateau_match_totals", {})
            plateau_building_completed = set(checkpoint.setdefault("plateau_building_completed", []))
            start_offset = int(plateau_offsets.get(city_code, 0))
            match_base = int(plateau_match_totals.get(city_code, 0))

            def plateau_progress(offset, matched_count):
                plateau_offsets[city_code] = offset
                plateau_match_totals[city_code] = match_base + matched_count
                write_checkpoint(args.checkpoint_file, checkpoint)

            def land_lot_progress(candidate_count):
                checkpoint["land_lot_candidate_count"] = candidate_count
                write_checkpoint(args.checkpoint_file, checkpoint)

            matched = 0
            if city_code not in plateau_building_completed:
                matched = match_plateau_buildings(
                    connection, parquet_path, start_offset, plateau_progress
                )
                plateau_match_totals[city_code] = match_base + matched
                plateau_building_completed.add(city_code)
                checkpoint["plateau_building_completed"] = sorted(plateau_building_completed)
                checkpoint["plateau_matches"] = sum(int(value) for value in plateau_match_totals.values())
                write_checkpoint(args.checkpoint_file, checkpoint)
            inserted = export_land_lots(
                connection, cities, [(city_code, parquet_path)], base_url, postcodes, land_lot_progress
            ) if args.land_lot else 0
            completed_bundles.add(city_code)
            checkpoint["plateau_completed"] = sorted(completed_bundles)
            plateau_match_totals[city_code] = match_base + matched
            checkpoint["plateau_matches"] = sum(int(value) for value in plateau_match_totals.values())
            checkpoint["land_lot_additions"] = connection.execute(
                "SELECT COUNT(*) FROM candidates WHERE source_id LIKE 'chiban/%'"
            ).fetchone()[0]
            write_checkpoint(args.checkpoint_file, checkpoint)
            print(f"Japan PLATEAU {city_code}: residential={matched} land_lot={inserted}",
                  file=sys.stderr, flush=True)
            return
        if args.stage == "osm" and args.osm_pbf and not checkpoint.get("osm_complete"):
            osm_match_base = int(checkpoint.get("osm_matches", 0))

            def osm_progress(scanned_ways, matched):
                checkpoint["osm_scanned_ways"] = scanned_ways
                checkpoint["osm_matches"] = osm_match_base + matched
                write_checkpoint(args.checkpoint_file, checkpoint)

            matched, scanned = match_residential_buildings(
                connection, args.osm_pbf, args.output,
                int(checkpoint.get("osm_scanned_ways", 0)), osm_progress
            )
            checkpoint["osm_scanned_ways"] = scanned
            checkpoint["osm_matches"] = osm_match_base + matched
            checkpoint["osm_complete"] = True
            write_checkpoint(args.checkpoint_file, checkpoint)
            return
        if args.stage == "osm" and not args.osm_pbf:
            checkpoint["osm_complete"] = True
            write_checkpoint(args.checkpoint_file, checkpoint)
            return
        if args.stage != "final":
            return
        selected = select_records(connection, args.max_records, args.per_locality)
        if not selected:
            raise RuntimeError("No ABR address point intersects an explicit residential building")
        write_records(args.output, selected)
        checkpoint["final_complete"] = True
        checkpoint["selected_count"] = len(selected)
        write_checkpoint(args.checkpoint_file, checkpoint)
    finally:
        connection.close()


if __name__ == "__main__":
    main()
