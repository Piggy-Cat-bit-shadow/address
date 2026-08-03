import argparse
import csv
import hashlib
import heapq
import json
import math
import pathlib
import re
import struct
import zipfile


INVALID_TEXT = {"", "N/A", "NINGUNO", "NINGUNA", "NO APLICA", "SIN NOMBRE", "SN", "S/N"}
POSTCODE_PATTERN = re.compile(r"^[0-9]{5}$")


def clean(value):
    return str(value or "").strip()


def normalized(value):
    return " ".join(clean(value).upper().split())


def stable_rank(parts):
    payload = "\x1f".join(parts).encode("utf-8", errors="replace")
    return int.from_bytes(hashlib.blake2b(payload, digest_size=8).digest(), "big")


def inverse_inegi_lambert(x, y):
    semi_major = 6378137.0
    flattening = 1 / 298.257222101
    eccentricity = math.sqrt(2 * flattening - flattening * flattening)
    parallel_1, parallel_2, latitude_origin = map(math.radians, (17.5, 29.5, 12.0))
    longitude_origin = math.radians(-102.0)

    def m(latitude):
        sine = math.sin(latitude)
        return math.cos(latitude) / math.sqrt(1 - eccentricity * eccentricity * sine * sine)

    def t(latitude):
        sine = math.sin(latitude)
        ratio = (1 - eccentricity * sine) / (1 + eccentricity * sine)
        return math.tan(math.pi / 4 - latitude / 2) / ratio ** (eccentricity / 2)

    t1, t2, t0 = t(parallel_1), t(parallel_2), t(latitude_origin)
    cone = (math.log(m(parallel_1)) - math.log(m(parallel_2))) / (math.log(t1) - math.log(t2))
    factor = m(parallel_1) / (cone * t1**cone)
    origin_radius = semi_major * factor * t0**cone
    east = x - 2500000.0
    north = origin_radius - y
    radius = math.copysign(math.hypot(east, north), cone)
    theta = math.atan2(east, north)
    projected_t = (radius / (semi_major * factor)) ** (1 / cone)
    latitude = math.pi / 2 - 2 * math.atan(projected_t)
    for _ in range(10):
        sine = math.sin(latitude)
        ratio = (1 - eccentricity * sine) / (1 + eccentricity * sine)
        latitude = math.pi / 2 - 2 * math.atan(projected_t * ratio ** (eccentricity / 2))
    return math.degrees(longitude_origin + theta / cone), math.degrees(latitude)


def read_dbf(data):
    record_count = struct.unpack("<I", data[4:8])[0]
    header_length = struct.unpack("<H", data[8:10])[0]
    record_length = struct.unpack("<H", data[10:12])[0]
    fields = []
    offset = 32
    while data[offset] != 13:
        descriptor = data[offset : offset + 32]
        name = descriptor[:11].split(b"\0", 1)[0].decode("ascii")
        fields.append((name, descriptor[16]))
        offset += 32
    wanted = {"NUMEXT", "IDUNICO", "CVEGEO", "TIPOVIAL", "NOMVIAL", "NOMASEN", "CP", "TIPODOM"}
    for index in range(record_count):
        record = data[header_length + index * record_length : header_length + (index + 1) * record_length]
        if not record or record[0] == 42:
            yield None
            continue
        position = 1
        values = {}
        for name, length in fields:
            if name in wanted:
                values[name] = record[position : position + length].decode("cp1252", errors="replace").strip()
            position += length
        yield values


def read_points(data):
    offset = 100
    while offset + 8 <= len(data):
        body_length = struct.unpack(">I", data[offset + 4 : offset + 8])[0] * 2
        body = offset + 8
        shape_type = struct.unpack("<I", data[body : body + 4])[0]
        yield struct.unpack("<dd", data[body + 4 : body + 20]) if shape_type == 1 else None
        offset = body + body_length


def select_raw_candidates(archive, max_records, per_locality):
    candidate_limit = min(max_records * 12, 250000)
    group_limit = max(12, per_locality * 12)
    groups = {}
    serial = 0
    archive_names = set(archive.namelist())
    basenames = sorted(name[:-4] for name in archive_names if name.endswith(".dbf") and name.startswith("direccion/"))
    for base in basenames:
        shape_name = f"{base}.shp"
        if shape_name not in archive_names:
            continue
        rows = read_dbf(archive.read(f"{base}.dbf"))
        points = read_points(archive.read(shape_name))
        for row, point in zip(rows, points):
            if row is None or point is None or normalized(row.get("TIPODOM")) != "VIVIENDA":
                continue
            number = clean(row.get("NUMEXT"))
            street_name = clean(row.get("NOMVIAL"))
            street_type = clean(row.get("TIPOVIAL"))
            district = clean(row.get("NOMASEN"))
            postcode = clean(row.get("CP"))
            cvegeo = clean(row.get("CVEGEO"))
            if (normalized(number) in INVALID_TEXT or normalized(street_name) in INVALID_TEXT
                    or normalized(district) in INVALID_TEXT or not POSTCODE_PATTERN.fullmatch(postcode)
                    or postcode == "00000" or len(cvegeo) < 9):
                continue
            longitude, latitude = inverse_inegi_lambert(*point)
            if not (-119 <= longitude <= -86 and 14 <= latitude <= 33):
                continue
            street = " ".join(value for value in (street_type, street_name) if normalized(value) not in INVALID_TEXT)
            source_id = f"{cvegeo}-{clean(row.get('IDUNICO')) or serial}"
            candidate = {
                "source_id": source_id,
                "group": cvegeo[:9],
                "number": number,
                "street": street,
                "district": district,
                "postcode": postcode,
                "longitude": longitude,
                "latitude": latitude,
            }
            rank = stable_rank((source_id, number, street, district, postcode))
            heap = groups.setdefault(candidate["group"], [])
            entry = (-rank, serial, candidate)
            serial += 1
            if len(heap) < group_limit:
                heapq.heappush(heap, entry)
            elif rank < -heap[0][0]:
                heapq.heapreplace(heap, entry)

    ranked = {
        group: [candidate for _, _, candidate in sorted((-rank, serial, candidate) for rank, serial, candidate in heap)]
        for group, heap in groups.items()
    }
    selected = []
    depth = 0
    group_names = sorted(ranked, key=lambda group: stable_rank((group,)))
    while len(selected) < candidate_limit:
        added = False
        for group in group_names:
            if depth < len(ranked[group]):
                selected.append(ranked[group][depth])
                added = True
                if len(selected) >= candidate_limit:
                    break
        if not added:
            break
        depth += 1
    return selected


def coordinate_key(longitude, latitude):
    return round(float(longitude), 7), round(float(latitude), 7)


def enrich_from_normalized_archive(candidates, archive, member):
    by_coordinate = {}
    for candidate in candidates:
        by_coordinate.setdefault(coordinate_key(candidate["longitude"], candidate["latitude"]), []).append(candidate)
    with archive.open(member) as raw:
        rows = csv.DictReader((line.decode("utf-8", errors="replace") for line in raw))
        for row in rows:
            try:
                key = coordinate_key(row.get("longitude"), row.get("latitude"))
            except (TypeError, ValueError):
                continue
            matches = by_coordinate.get(key)
            if not matches:
                continue
            admin1 = clean(row.get("estado"))
            locality = clean(row.get("cidade"))
            if not admin1 or not locality:
                continue
            row_number = normalized(row.get("hnum"))
            row_street = normalized(row.get("via"))
            match = next((entry for entry in matches
                          if normalized(entry["number"]) == row_number and normalized(entry["street"]) == row_street), matches[0])
            match["admin1"] = admin1
            match["locality"] = locality
            matches.remove(match)
            if not matches:
                by_coordinate.pop(key, None)
            if not by_coordinate:
                break


parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--normalized-input", required=True)
parser.add_argument("--normalized-member", default="produto_final.csv")
parser.add_argument("--output", required=True)
parser.add_argument("--max-records", type=int, required=True)
parser.add_argument("--per-locality", type=int, required=True)
args = parser.parse_args()

if args.max_records < 1 or args.per_locality < 1:
    raise ValueError("record limits must be positive")

with zipfile.ZipFile(args.input) as source_archive:
    selected = select_raw_candidates(source_archive, args.max_records, args.per_locality)
with zipfile.ZipFile(args.normalized_input) as normalized_archive:
    if args.normalized_member not in normalized_archive.namelist():
        raise ValueError(f"normalized archive member is missing: {args.normalized_member}")
    enrich_from_normalized_archive(selected, normalized_archive, args.normalized_member)

output = pathlib.Path(args.output)
written = 0
with output.open("w", encoding="utf-8", newline="\n") as destination:
    for candidate in selected:
        if not candidate.get("admin1") or not candidate.get("locality"):
            continue
        source_id = candidate["source_id"]
        record = {
            "id": f"inegi-mx-{source_id}",
            "country": "MX",
            "admin1": candidate["admin1"],
            "locality": candidate["locality"],
            "postal_city": candidate["locality"],
            "district": candidate["district"],
            "address_levels": [candidate["admin1"], candidate["locality"], candidate["district"]],
            "postcode": candidate["postcode"],
            "street": candidate["street"],
            "number": candidate["number"],
            "unit": "",
            "longitude": candidate["longitude"],
            "latitude": candidate["latitude"],
            "property_type": "residential",
            "residential_building_id": f"inegi-dwelling-{source_id}",
            "residential_building_class": "dwelling_house",
            "source_dataset": "INEGI nationwide dwelling addresses",
            "source_record_id": source_id,
        }
        destination.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        written += 1
        if written >= args.max_records:
            break
