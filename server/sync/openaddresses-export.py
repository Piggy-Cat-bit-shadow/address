import argparse
import csv
import hashlib
import heapq
import json
import pathlib
import zipfile


def clean(value):
    return str(value or "").strip()


def stable_rank(parts):
    payload = "\x1f".join(parts).encode("utf-8", errors="replace")
    return int.from_bytes(hashlib.blake2b(payload, digest_size=8).digest(), "big")


parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--member", action="append", required=True)
parser.add_argument("--mapping-file", required=True)
parser.add_argument("--country", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--max-records", type=int, required=True)
parser.add_argument("--per-locality", type=int, required=True)
args = parser.parse_args()

if not args.country.isalpha() or len(args.country) != 2:
    raise ValueError("country must be an ISO alpha-2 code")
if args.max_records < 1 or args.per_locality < 1:
    raise ValueError("record limits must be positive")

mapping = json.loads(pathlib.Path(args.mapping_file).read_text(encoding="utf-8"))
required_mapping = {"id", "number", "street", "district", "locality", "admin1", "postcode", "longitude", "latitude"}
if not required_mapping.issubset(mapping) or not all(isinstance(mapping[key], str) and mapping[key] for key in required_mapping):
    raise ValueError("mapping-file is missing required CSV columns")

candidate_limit = min(max(args.max_records * 12, args.max_records), 250000)
candidates = []
encoding = clean(mapping.get("encoding")) or "utf-8-sig"

with zipfile.ZipFile(args.input) as archive:
    archive_members = set(archive.namelist())
    for member in args.member:
        if member not in archive_members:
            raise ValueError(f"archive member is missing: {member}")
    for member in args.member:
        member_id = hashlib.blake2b(member.encode("utf-8"), digest_size=4).hexdigest()
        with archive.open(member) as raw:
            rows = csv.DictReader((line.decode(encoding, errors="replace") for line in raw))
            for row_number, row in enumerate(rows, start=2):
                number = clean(row.get(mapping["number"]))
                street = clean(row.get(mapping["street"]))
                district = clean(row.get(mapping["district"]))
                locality = clean(row.get(mapping["locality"]))
                admin1 = clean(row.get(mapping["admin1"]))
                postcode = clean(row.get(mapping["postcode"]))
                try:
                    longitude = float(clean(row.get(mapping["longitude"])))
                    latitude = float(clean(row.get(mapping["latitude"])))
                except ValueError:
                    continue
                if not all((number, street, district, locality, admin1, postcode)):
                    continue
                if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
                    continue
                address_key = (
                    args.country.upper(), admin1.casefold(), locality.casefold(), district.casefold(),
                    postcode.casefold(), street.casefold(), number.casefold(), longitude, latitude
                )
                raw_record_id = clean(row.get(mapping["id"])) or str(row_number)
                record_id = f"{member_id}-{raw_record_id}"
                record = {
                    "id": f"oa-{args.country.lower()}-{record_id}",
                    "country": args.country.upper(),
                    "admin1": admin1,
                    "locality": locality,
                    "postal_city": locality,
                    "district": district,
                    "address_levels": [admin1, locality, district],
                    "postcode": postcode,
                    "street": street,
                    "number": number,
                    "unit": "",
                    "longitude": longitude,
                    "latitude": latitude,
                    "source_dataset": clean(mapping.get("sourceDataset")) or "OpenAddresses",
                    "source_record_id": record_id,
                }
                rank = stable_rank((record_id, number, street, district, locality, admin1, postcode))
                entry = (-rank, record_id, record)
                if len(candidates) < candidate_limit:
                    heapq.heappush(candidates, entry)
                elif rank < -candidates[0][0]:
                    heapq.heapreplace(candidates, entry)

ranked_groups = {}
for negative_rank, record_id, record in candidates:
    group = "\x1f".join((record["admin1"].casefold(), record["locality"].casefold(), record["district"].casefold()))
    ranked_groups.setdefault(group, []).append((-negative_rank, record_id, record))
for records in ranked_groups.values():
    records.sort()
del candidates
selected = []
selected_addresses = set()
depth = 0
group_names = sorted(ranked_groups)
while len(selected) < candidate_limit:
    added = False
    for group in group_names:
        records = ranked_groups[group]
        if depth < len(records):
            record = records[depth][2]
            address_key = (
                record["country"], record["admin1"].casefold(), record["locality"].casefold(),
                record["district"].casefold(), record["postcode"].casefold(), record["street"].casefold(),
                record["number"].casefold(), record["longitude"], record["latitude"]
            )
            if address_key not in selected_addresses:
                selected_addresses.add(address_key)
                selected.append(record)
            added = True
            if len(selected) >= candidate_limit:
                break
    if not added:
        break
    depth += 1

output = pathlib.Path(args.output)
with output.open("w", encoding="utf-8", newline="\n") as destination:
    for record in selected:
        destination.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
