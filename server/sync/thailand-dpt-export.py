import argparse
import hashlib
import json
import os
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque


RESIDENTIAL_WHERE = (
    "BL_CLASS17 = 1 OR BL_CLASS18 = 1 OR BL_CLASS20 = 1 "
    "OR BL_CLASS22 = 1 OR BL_CLASS54 = 1"
)
EXPORT_WHERE = (
    f"({RESIDENTIAL_WHERE}) AND BL_ID IS NOT NULL AND BL_ID <> '' "
    "AND BL_HOUSENUM IS NOT NULL AND BL_HOUSENUM <> '' "
    "AND BL_ROAD IS NOT NULL AND BL_ROAD <> '' "
    "AND BL_TAMBOL IS NOT NULL AND BL_TAMBOL <> '' "
    "AND BL_AMPHOE IS NOT NULL AND BL_AMPHOE <> '' "
    "AND BL_CHANGWAT IS NOT NULL AND BL_CHANGWAT <> '' "
    "AND BL_POSTCODE IS NOT NULL AND BL_POSTCODE <> ''"
)
OUT_FIELDS = (
    "OBJECTID,BL_ID,BL_HOUSENUM,BL_ROAD,BL_TAMBOL,BL_AMPHOE,BL_CHANGWAT,"
    "BL_POSTCODE,BL_CLASS17,BL_CLASS18,BL_CLASS20,BL_CLASS22,BL_CLASS54"
)
THAI_PATTERN = re.compile(r"[\u0e00-\u0e7f]")
POSTCODE_PATTERN = re.compile(r"[0-9]{5}")
HOUSE_NUMBER_PATTERN = re.compile(
    r"[0-9\u0e50-\u0e59]{1,8}(?:[/\-][0-9\u0e50-\u0e59]{1,8})?(?:[A-Za-z\u0e00-\u0e7f])?"
)
CLASS_FIELDS = {
    "BL_CLASS17": ("residential", "residential"),
    "BL_CLASS18": ("apartment", "apartment"),
    "BL_CLASS20": ("apartment", "apartment"),
    "BL_CLASS22": ("residential", "dormitory"),
    "BL_CLASS54": ("apartment", "apartment"),
}


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def stable_digest(value):
    return hashlib.sha256(str(value).encode("utf-8")).digest()


def request_json(url, parameters=None, attempts=5, timeout=45):
    encoded = urllib.parse.urlencode(parameters or {}).encode("utf-8")
    use_post = len(encoded) > 1500
    target = url if use_post or not encoded else f"{url}?{encoded.decode('ascii')}"
    last_error = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                target,
                data=encoded if use_post else None,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "address-sync/1.0",
                },
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.load(response)
            if not isinstance(payload, dict):
                raise ValueError("ArcGIS response is not an object")
            if "error" in payload:
                error = payload.get("error") or {}
                raise RuntimeError(error.get("message") or "ArcGIS query failed")
            return payload
        except (OSError, ValueError, RuntimeError, urllib.error.HTTPError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(min(16, 2 ** attempt))
    raise last_error


def object_ids(layer_url):
    payload = request_json(f"{layer_url.rstrip('/')}/query", {
        "f": "json",
        "where": EXPORT_WHERE,
        "returnIdsOnly": "true",
    })
    values = {value for value in payload.get("objectIds", []) if value is not None}
    return sorted(values, key=lambda value: (stable_digest(value), str(value)))


def building_features(layer_url, identifiers):
    payload = request_json(f"{layer_url.rstrip('/')}/query", {
        "f": "json",
        "objectIds": ",".join(map(str, identifiers)),
        "outFields": OUT_FIELDS,
        "returnGeometry": "true",
        "outSR": "4326",
    })
    return payload.get("features", [])


def ring_area_and_centroid(ring):
    points = []
    for point in ring or []:
        try:
            points.append((float(point[0]), float(point[1])))
        except (IndexError, TypeError, ValueError):
            return 0.0, None
    if len(points) < 3:
        return 0.0, None
    if points[0] != points[-1]:
        points.append(points[0])
    twice_area = 0.0
    longitude_sum = 0.0
    latitude_sum = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        cross = x1 * y2 - x2 * y1
        twice_area += cross
        longitude_sum += (x1 + x2) * cross
        latitude_sum += (y1 + y2) * cross
    if abs(twice_area) < 1e-15:
        return 0.0, None
    return twice_area / 2, (
        longitude_sum / (3 * twice_area),
        latitude_sum / (3 * twice_area),
    )


def point_in_ring(point, ring):
    x, y = point
    inside = False
    points = ring if ring and ring[0] == ring[-1] else (ring or []) + (ring[:1] if ring else [])
    for first, second in zip(points, points[1:]):
        try:
            x1, y1 = float(first[0]), float(first[1])
            x2, y2 = float(second[0]), float(second[1])
        except (IndexError, TypeError, ValueError):
            return False
        if (y1 > y) != (y2 > y):
            crossing = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < crossing:
                inside = not inside
    return inside


def point_in_polygon(point, rings):
    return sum(1 for ring in rings if point_in_ring(point, ring)) % 2 == 1


def scanline_point(rings):
    normalized = [[(float(value[0]), float(value[1])) for value in ring] for ring in rings]
    latitudes = [value[1] for ring in normalized for value in ring]
    low, high = min(latitudes), max(latitudes)
    for fraction in (0.5, 0.37, 0.63, 0.25, 0.75):
        latitude = low + (high - low) * fraction
        crossings = []
        for ring in normalized:
            closed = ring if ring[0] == ring[-1] else ring + ring[:1]
            for (x1, y1), (x2, y2) in zip(closed, closed[1:]):
                if (y1 <= latitude < y2) or (y2 <= latitude < y1):
                    crossings.append(x1 + (latitude - y1) * (x2 - x1) / (y2 - y1))
        crossings.sort()
        segments = [(right - left, (left + right) / 2) for left, right in zip(crossings[::2], crossings[1::2])]
        if segments:
            _, longitude = max(segments)
            return longitude, latitude
    return None


def polygon_point(geometry):
    rings = geometry.get("rings", []) if isinstance(geometry, dict) else []
    candidates = []
    for ring in rings:
        area, centroid = ring_area_and_centroid(ring)
        if centroid:
            candidates.append((abs(area), ring, centroid))
    for _, _, centroid in sorted(candidates, reverse=True, key=lambda item: item[0]):
        point = centroid if point_in_polygon(centroid, rings) else scanline_point(rings)
        if point and 97 <= point[0] <= 106 and 5 <= point[1] <= 21:
            return point
    return None


def enabled(value):
    return value is True or clean(value).lower() in {"1", "true", "yes", "y"}


def residential_class(attributes):
    matches = [field for field in CLASS_FIELDS if enabled(attributes.get(field))]
    if not matches:
        return None
    if any(field in matches for field in ("BL_CLASS18", "BL_CLASS20", "BL_CLASS54")):
        property_type, building_class = "apartment", "apartment"
    elif "BL_CLASS22" in matches:
        property_type, building_class = "residential", "dormitory"
    else:
        property_type, building_class = "residential", "residential"
    return property_type, building_class, ",".join(matches)


def record(feature):
    attributes = feature.get("attributes", {}) if isinstance(feature, dict) else {}
    building_id = clean(attributes.get("BL_ID"))
    number = clean(attributes.get("BL_HOUSENUM"))
    street = clean(attributes.get("BL_ROAD"))
    district = clean(attributes.get("BL_TAMBOL"))
    locality = clean(attributes.get("BL_AMPHOE"))
    admin1 = clean(attributes.get("BL_CHANGWAT"))
    postcode = clean(attributes.get("BL_POSTCODE"))
    residence = residential_class(attributes)
    if not all((building_id, number, street, district, locality, admin1, postcode, residence)):
        return None
    if not HOUSE_NUMBER_PATTERN.fullmatch(number) or not POSTCODE_PATTERN.fullmatch(postcode):
        return None
    if not all(THAI_PATTERN.search(value) for value in (street, district, locality, admin1)):
        return None
    point = polygon_point(feature.get("geometry"))
    if not point:
        return None
    property_type, building_class, evidence = residence
    source_id = f"dpt-building:{building_id}"
    return {
        "id": source_id,
        "source_record_id": source_id,
        "source_dataset": "Thailand DPT official building database",
        "country": "TH",
        "admin1": admin1,
        "locality": locality,
        "district": district,
        "postal_city": locality,
        "address_levels": [admin1, locality, district],
        "postcode": postcode,
        "street": street,
        "number": number,
        "longitude": point[0],
        "latitude": point[1],
        "property_type": property_type,
        "residential_building_id": source_id,
        "residential_building_class": building_class,
        "residential_evidence": evidence,
    }


def identity(value):
    return "\x1f".join(clean(value[field]).casefold() for field in (
        "number", "street", "district", "locality", "admin1", "postcode"
    ))


def locality_identity(value):
    return "\x1f".join(clean(value[field]).casefold() for field in ("admin1", "locality", "district"))


def load_jsonl(path):
    values = []
    if not pathlib.Path(path).exists():
        return values
    with open(path, encoding="utf-8") as source:
        for line in source:
            try:
                value = json.loads(line)
            except (TypeError, ValueError):
                continue
            if isinstance(value, dict):
                values.append(value)
    return values


def select_balanced(values, maximum, per_locality):
    unique = {}
    for value in values:
        unique.setdefault(identity(value), value)
    localities = defaultdict(list)
    for value in unique.values():
        localities[locality_identity(value)].append(value)
    admin_queues = defaultdict(deque)
    for locality_key, records in sorted(localities.items()):
        records.sort(key=lambda value: (stable_digest(identity(value)), identity(value)))
        queue = deque(records[:per_locality])
        admin_queues[records[0]["admin1"]].append((locality_key, queue))
    selected = []
    admins = deque(sorted(admin_queues))
    while admins and len(selected) < maximum:
        remaining_admins = deque()
        while admins and len(selected) < maximum:
            admin = admins.popleft()
            locality_queue = admin_queues[admin]
            locality_key, records = locality_queue.popleft()
            selected.append(records.popleft())
            if records:
                locality_queue.append((locality_key, records))
            if locality_queue:
                remaining_admins.append(admin)
        admins = remaining_admins
    return selected


def atomic_json(path, value):
    target = pathlib.Path(path)
    temporary = target.with_name(f"{target.name}.tmp")
    with open(temporary, "w", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, target)


def export(layer_url, output_path, maximum, per_locality, batch_size=500, checkpoint_path=None):
    output = pathlib.Path(output_path)
    checkpoint = pathlib.Path(checkpoint_path or f"{output_path}.checkpoint.json")
    partial = pathlib.Path(f"{checkpoint}.candidates.jsonl")
    output.parent.mkdir(parents=True, exist_ok=True)
    identifiers = object_ids(layer_url)
    fingerprint = hashlib.sha256(
        (layer_url.rstrip("/") + "\n" + "\n".join(map(str, identifiers))).encode("utf-8")
    ).hexdigest()
    state = {}
    if checkpoint.exists():
        try:
            state = json.loads(checkpoint.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
    if state.get("fingerprint") != fingerprint or not partial.exists():
        partial.unlink(missing_ok=True)
        state = {"fingerprint": fingerprint, "next_offset": 0}
        atomic_json(checkpoint, state)
    offset = max(0, min(int(state.get("next_offset", 0)), len(identifiers)))
    accepted = load_jsonl(partial)
    seen = {identity(value) for value in accepted}
    with open(partial, "a", encoding="utf-8", newline="\n") as candidates:
        while offset < len(identifiers):
            batch = identifiers[offset:offset + batch_size]
            for feature in building_features(layer_url, batch):
                value = record(feature)
                if not value or identity(value) in seen:
                    continue
                seen.add(identity(value))
                accepted.append(value)
                candidates.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
            candidates.flush()
            os.fsync(candidates.fileno())
            offset += len(batch)
            atomic_json(checkpoint, {"fingerprint": fingerprint, "next_offset": offset})
    selected = select_balanced(accepted, max(0, maximum), max(1, per_locality))
    temporary = output.with_name(f"{output.name}.tmp")
    with open(temporary, "w", encoding="utf-8", newline="\n") as destination:
        for value in selected:
            destination.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        destination.flush()
        os.fsync(destination.fileno())
    os.replace(temporary, output)
    checkpoint.unlink(missing_ok=True)
    partial.unlink(missing_ok=True)
    return {"accepted": len(selected), "candidates": len(accepted), "scanned": len(identifiers)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--layer-url", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-records", required=True, type=int)
    parser.add_argument("--per-locality", type=int, default=1000)
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--checkpoint")
    args = parser.parse_args()
    result = export(
        args.layer_url,
        args.output,
        args.max_records,
        args.per_locality,
        max(1, min(args.batch_size, 1000)),
        args.checkpoint,
    )
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
