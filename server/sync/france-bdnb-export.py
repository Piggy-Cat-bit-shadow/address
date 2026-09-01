import argparse
import csv
import hashlib
import json
import math
import os
import pathlib
import re
import zipfile
from collections import defaultdict


USAGE_MEMBER = "csv/batiment_groupe_synthese_propriete_usage.csv"
RELATION_MEMBER = "csv/rel_batiment_groupe_adresse.csv"
ADDRESS_MEMBER = "csv/adresse.csv"
POSTCODE_PATTERN = re.compile(r"^[0-9]{5}$")
COMMUNE_CODE_PATTERN = re.compile(r"^[0-9A-Z]{5}$")
POINT_PATTERN = re.compile(
    r"^POINT(?:\s+Z)?\s*\(\s*([-+]?[0-9]+(?:\.[0-9]+)?)\s+([-+]?[0-9]+(?:\.[0-9]+)?)(?:\s+[-+]?[0-9]+(?:\.[0-9]+)?)?\s*\)$",
    re.IGNORECASE,
)
RESIDENTIAL_USAGES = {
    "Résidentiel individuel": ("residential", "individual-residential"),
    "Résidentiel collectif": ("apartment", "collective-residential"),
}
ADMIN1 = "Nouvelle-Aquitaine"
ADMIN1_CODE = "NAQ"
DEPARTMENT = "Creuse"
DEPARTMENT_CODE = "23"


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def stable_key(value):
    return hashlib.sha256(value.encode("utf-8")).digest()


def lambert93_to_wgs84(x, y):
    eccentricity = 0.0818191910428158
    exponent = 0.7256077650532670
    constant = 11754255.426096
    false_easting = 700000.0
    false_northing = 12655612.049876
    longitude_origin = math.radians(3.0)
    radius = math.hypot(x - false_easting, y - false_northing)
    if radius <= 0:
        raise ValueError("Invalid Lambert-93 coordinate")
    angle = math.atan2(x - false_easting, false_northing - y)
    longitude = longitude_origin + angle / exponent
    latitude_iso = -math.log(radius / constant) / exponent
    latitude = 2 * math.atan(math.exp(latitude_iso)) - math.pi / 2
    for _ in range(12):
        sine = math.sin(latitude)
        updated = 2 * math.atan(
            math.exp(latitude_iso)
            * ((1 + eccentricity * sine) / (1 - eccentricity * sine)) ** (eccentricity / 2)
        ) - math.pi / 2
        if abs(updated - latitude) < 1e-12:
            latitude = updated
            break
        latitude = updated
    return math.degrees(longitude), math.degrees(latitude)


def parse_point(value):
    match = POINT_PATTERN.fullmatch(clean(value))
    if not match:
        return None
    try:
        longitude, latitude = lambert93_to_wgs84(float(match.group(1)), float(match.group(2)))
    except (OverflowError, ValueError):
        return None
    if not (-6 <= longitude <= 10 and 41 <= latitude <= 52):
        return None
    return longitude, latitude


def csv_rows(archive, member):
    with archive.open(member) as raw:
        import io
        with io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as text:
            yield from csv.DictReader(text, delimiter=";")


def residential_buildings(archive):
    result = {}
    for row in csv_rows(archive, USAGE_MEMBER):
        building_id = clean(row.get("batiment_groupe_id"))
        usage = clean(row.get("usage_principal_bdnb_open"))
        if building_id and usage in RESIDENTIAL_USAGES:
            result[building_id] = usage
    return result


def residential_address_evidence(archive, buildings, minimum_fiability):
    evidence = {}
    for row in csv_rows(archive, RELATION_MEMBER):
        building_id = clean(row.get("batiment_groupe_id"))
        address_id = clean(row.get("cle_interop_adr"))
        try:
            fiability = int(clean(row.get("fiabilite")))
        except ValueError:
            continue
        if not address_id or building_id not in buildings or fiability < minimum_fiability:
            continue
        candidate = (fiability, building_id, buildings[building_id])
        current = evidence.get(address_id)
        if current is None or (candidate[0], candidate[1]) > (current[0], current[1]):
            evidence[address_id] = candidate
    return evidence


def normalized_record(row, evidence):
    address_id = clean(row.get("cle_interop_adr"))
    residence = evidence.get(address_id)
    if residence is None or clean(row.get("source")).upper() != "BAN":
        return None
    number = clean(row.get("numero"))
    suffix = clean(row.get("rep"))
    street_type = clean(row.get("type_voie"))
    street_name = clean(row.get("nom_voie"))
    postcode = clean(row.get("code_postal"))
    commune_code = clean(row.get("code_commune_insee")).upper()
    commune = clean(row.get("libelle_commune"))
    point = parse_point(row.get("WKT"))
    if not all((address_id, number, street_name, commune, point)):
        return None
    if not POSTCODE_PATTERN.fullmatch(postcode) or not COMMUNE_CODE_PATTERN.fullmatch(commune_code):
        return None
    house_number = " ".join(filter(None, (number, suffix.lower())))
    street = " ".join(filter(None, (street_type.capitalize(), street_name)))
    fiability, building_id, usage = residence
    property_type, building_class = RESIDENTIAL_USAGES[usage]
    longitude, latitude = point
    return {
        "id": f"bdnb-ban:{address_id}",
        "source_record_id": f"bdnb-ban:{address_id}",
        "source_dataset": "CSTB BDNB and Base Adresse Nationale",
        "country": "FR",
        "admin1": ADMIN1,
        "admin1_code": ADMIN1_CODE,
        "district": DEPARTMENT,
        "district_code": DEPARTMENT_CODE,
        "locality": commune,
        "locality_code": commune_code,
        "postal_city": commune,
        "address_levels": [ADMIN1, DEPARTMENT, commune],
        "postcode": postcode,
        "street": street,
        "number": house_number,
        "property_type": property_type,
        "residential_building_id": f"bdnb:{building_id}",
        "residential_building_class": building_class,
        "residential_evidence": (
            f"usage_principal_bdnb_open={usage};fiabilite={fiability};address_source=BAN"
        ),
        "longitude": round(longitude, 7),
        "latitude": round(latitude, 7),
    }


def select_records(records, maximum, per_locality):
    groups = defaultdict(list)
    for record in records:
        groups[record["locality_code"]].append(record)
    for values in groups.values():
        values.sort(key=lambda value: stable_key(value["source_record_id"]))
        if per_locality > 0:
            del values[per_locality:]
    selected = []
    keys = sorted(groups, key=stable_key)
    offset = 0
    while len(selected) < maximum:
        added = False
        for key in keys:
            if offset < len(groups[key]):
                selected.append(groups[key][offset])
                added = True
                if len(selected) == maximum:
                    break
        if not added:
            break
        offset += 1
    return selected


def export(archive_path, output_path, maximum, per_locality, minimum_fiability=17):
    with zipfile.ZipFile(archive_path) as archive:
        required = {USAGE_MEMBER, RELATION_MEMBER, ADDRESS_MEMBER}
        missing = sorted(required.difference(archive.namelist()))
        if missing:
            raise ValueError(f"BDNB archive is missing required members: {', '.join(missing)}")
        buildings = residential_buildings(archive)
        evidence = residential_address_evidence(archive, buildings, minimum_fiability)
        records = []
        for row in csv_rows(archive, ADDRESS_MEMBER):
            record = normalized_record(row, evidence)
            if record is not None:
                records.append(record)
    selected = select_records(records, maximum, per_locality)
    destination = pathlib.Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f"{destination.name}.{os.getpid()}.tmp")
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as output:
            for record in selected:
                output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "residential_buildings": len(buildings),
        "strict_address_keys": len(evidence),
        "publishable": len(records),
        "selected": len(selected),
        "communes": len({record["locality_code"] for record in selected}),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-records", type=int, required=True)
    parser.add_argument("--per-locality", type=int, required=True)
    parser.add_argument("--minimum-fiability", type=int, default=17)
    arguments = parser.parse_args()
    if arguments.max_records <= 0 or arguments.per_locality <= 0 or arguments.minimum_fiability < 0:
        parser.error("record limits must be positive and fiability must be non-negative")
    result = export(
        arguments.input,
        arguments.output,
        arguments.max_records,
        arguments.per_locality,
        arguments.minimum_fiability,
    )
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
