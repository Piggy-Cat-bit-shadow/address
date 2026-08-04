import argparse
import csv
import json
from pathlib import Path


REQUIRED_FIELDS = {
    "id", "number", "street", "locality", "admin1", "postcode", "longitude", "latitude"
}


def value_at(row, path):
    value = row
    for part in str(path).split("."):
        if not isinstance(value, dict):
            return ""
        value = value.get(part)
    return value


def text(value):
    return " ".join(str(value or "").strip().split())


def rows_from(path, file_format):
    resolved = file_format
    if resolved == "auto":
        suffix = path.suffix.lower()
        resolved = "csv" if suffix == ".csv" else "json" if suffix == ".json" else "jsonl"
    if resolved == "csv":
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            yield from csv.DictReader(stream)
        return
    if resolved == "json":
        with path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
        if isinstance(payload, dict):
            payload = payload.get("records") or payload.get("data") or []
        if not isinstance(payload, list):
            raise ValueError("Licensed JSON feed must contain an array, records, or data")
        yield from payload
        return
    if resolved != "jsonl":
        raise ValueError("Licensed feed format must be auto, csv, json, or jsonl")
    with path.open("r", encoding="utf-8-sig") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def normalize(row, mapping, country, source_name, residential_values, dataset_residential):
    values = {name: value_at(row, source) for name, source in mapping.items()}
    residential_class = text(values.get("residentialClass"))
    if not dataset_residential and residential_class.casefold() not in residential_values:
        return None
    source_id = text(values.get("id"))
    number = text(values.get("number"))
    street = text(values.get("street"))
    locality = text(values.get("locality"))
    admin1 = text(values.get("admin1"))
    postcode = text(values.get("postcode"))
    district = text(values.get("district"))
    try:
        longitude = float(values.get("longitude"))
        latitude = float(values.get("latitude"))
    except (TypeError, ValueError):
        return None
    if not all((source_id, number, street, locality, admin1, postcode)):
        return None
    if country == "NG" and not district:
        return None
    if country == "VN" and (len(postcode) != 5 or not postcode.isdigit()):
        return None
    if country == "NG" and (len(postcode) != 6 or not postcode.isdigit()):
        return None
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        return None
    evidence = residential_class or "licensed-residential-dataset"
    return {
        "id": source_id,
        "source_record_id": source_id,
        "source_dataset": source_name,
        "number": number,
        "street": street,
        "building_name": text(values.get("buildingName")),
        "unit": text(values.get("unit")),
        "district": district,
        "locality": locality,
        "admin1": admin1,
        "postcode": postcode,
        "longitude": longitude,
        "latitude": latitude,
        "property_type": "residential",
        "residential_building_id": source_id,
        "residential_building_class": f"licensed:{evidence}",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--country", required=True, choices=("VN", "NG"))
    parser.add_argument("--source-name", required=True)
    parser.add_argument("--mapping-json", required=True)
    parser.add_argument("--format", default="auto")
    parser.add_argument("--residential-values", default="")
    parser.add_argument("--dataset-residential", action="store_true")
    parser.add_argument("--max-records", type=int, required=True)
    args = parser.parse_args()

    mapping = json.loads(args.mapping_json)
    missing = REQUIRED_FIELDS.difference(mapping)
    if missing:
        raise ValueError(f"Licensed feed mapping is missing: {', '.join(sorted(missing))}")
    if not args.dataset_residential and "residentialClass" not in mapping:
        raise ValueError("Licensed feed mapping requires residentialClass")
    residential_values = {
        value.strip().casefold() for value in args.residential_values.split(",") if value.strip()
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    accepted = 0
    seen = set()
    with output.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows_from(Path(args.input), args.format):
            if not isinstance(row, dict):
                continue
            record = normalize(
                row, mapping, args.country, args.source_name,
                residential_values, args.dataset_residential
            )
            if not record or record["id"] in seen:
                continue
            seen.add(record["id"])
            stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            accepted += 1
            if accepted >= args.max_records:
                break
    if accepted == 0:
        raise ValueError("Licensed feed produced no strictly residential address records")


if __name__ == "__main__":
    main()
