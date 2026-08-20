import argparse
import hashlib
import heapq
import json
import math
import os
import pathlib
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

GML = "http://www.opengis.net/gml/3.2"
XLINK = "http://www.w3.org/1999/xlink"
POSTCODE_PATTERN = re.compile(r"^[0-9]{5}$")
CADASTRAL_REFERENCE_PATTERN = re.compile(r"^[0-9A-Z]{14}$")
DIGIT_PATTERN = re.compile(r"[0-9]")


def utm30_to_wgs84(easting, northing):
    semi_major = 6378137.0
    eccentricity_squared = 0.00669438002290
    scale = 0.9996
    x = easting - 500000.0
    meridional_arc = northing / scale
    mu = meridional_arc / (semi_major * (1 - eccentricity_squared / 4
        - 3 * eccentricity_squared**2 / 64 - 5 * eccentricity_squared**3 / 256))
    e1 = (1 - math.sqrt(1 - eccentricity_squared)) / (1 + math.sqrt(1 - eccentricity_squared))
    latitude1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + 151 * e1**3 / 96 * math.sin(6 * mu) + 1097 * e1**4 / 512 * math.sin(8 * mu))
    e_prime_squared = eccentricity_squared / (1 - eccentricity_squared)
    n1 = semi_major / math.sqrt(1 - eccentricity_squared * math.sin(latitude1)**2)
    t1 = math.tan(latitude1)**2
    c1 = e_prime_squared * math.cos(latitude1)**2
    r1 = semi_major * (1 - eccentricity_squared) / (
        1 - eccentricity_squared * math.sin(latitude1)**2) ** 1.5
    d = x / (n1 * scale)
    latitude = latitude1 - (n1 * math.tan(latitude1) / r1) * (
        d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * e_prime_squared) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * e_prime_squared - 3 * c1**2) * d**6 / 720)
    longitude = math.radians(-3) + (
        d - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * e_prime_squared + 24 * t1**2) * d**5 / 120
    ) / math.cos(latitude1)
    return math.degrees(longitude), math.degrees(latitude)


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalized_name(value):
    return "".join(character for character in unicodedata.normalize("NFKD", clean(value).casefold())
                   if not unicodedata.combining(character))


def child_text(element, name):
    for child in element.iter():
        if local_name(child.tag) == name and clean(child.text):
            return clean(child.text)
    return ""


def element_id(element):
    return clean(element.get(f"{{{GML}}}id"))


def archive_member(archive, suffix):
    matches = [name for name in archive.namelist() if name.lower().endswith(suffix)]
    if len(matches) != 1:
        raise ValueError(f"Expected one {suffix} member, found {len(matches)}")
    return matches[0]


def iter_features(archive, member, feature_name):
    with archive.open(member) as source:
        for _, element in ET.iterparse(source, events=("end",)):
            if local_name(element.tag) == feature_name:
                yield element
                element.clear()


def language_is_spanish(element):
    languages = [clean(child.text).lower() for child in element.iter()
                 if local_name(child.tag) == "language" and clean(child.text)]
    return languages == ["esp"]


def geographical_name(element):
    if not language_is_spanish(element):
        return ""
    values = [clean(child.text) for child in element.iter()
              if local_name(child.tag) == "text" and clean(child.text)]
    return values[0] if len(values) == 1 else ""


def component_definitions(addresses_archive, member):
    definitions = {}
    for feature_name in ("ThoroughfareName", "PostalDescriptor", "AdminUnitName"):
        for element in iter_features(addresses_archive, member, feature_name):
            identifier = element_id(element)
            if not identifier:
                continue
            if feature_name == "PostalDescriptor":
                postcode = child_text(element, "postCode")
                if language_is_spanish(element) and POSTCODE_PATTERN.fullmatch(postcode):
                    definitions[identifier] = (feature_name, postcode)
            else:
                name = geographical_name(element)
                if name:
                    definitions[identifier] = (feature_name, name)
    return definitions


def residential_buildings(buildings_archive, member):
    references = set()
    for element in iter_features(buildings_archive, member, "Building"):
        current_use = child_text(element, "currentUse")
        dwellings = child_text(element, "numberOfDwellings")
        reference = child_text(element, "reference").upper()
        try:
            dwelling_count = int(dwellings)
        except ValueError:
            continue
        if (current_use == "1_residential" and dwelling_count > 0
                and CADASTRAL_REFERENCE_PATTERN.fullmatch(reference)):
            references.add(reference)
    return references


def address_record(element, definitions, residential, province, province_code,
                   municipality, municipality_code):
    identifier = element_id(element)
    local_identifier = child_text(element, "localId")
    cadastral_reference = local_identifier.rsplit(".", 1)[-1].upper()
    if not identifier or not CADASTRAL_REFERENCE_PATTERN.fullmatch(cadastral_reference):
        return None
    if cadastral_reference not in residential:
        return None
    number = child_text(element, "designator")
    if not number or not DIGIT_PATTERN.search(number):
        return None
    position = child_text(element, "pos").split()
    point = next((child for child in element.iter() if local_name(child.tag) == "Point"), None)
    if point is None or "25830" not in clean(point.get("srsName")) or len(position) != 2:
        return None
    try:
        longitude, latitude = utm30_to_wgs84(float(position[0]), float(position[1]))
    except (TypeError, ValueError):
        return None
    if not (-10 <= longitude <= 5 and 35 <= latitude <= 44):
        return None
    components = {}
    for child in element.iter():
        if local_name(child.tag) != "component":
            continue
        reference = clean(child.get(f"{{{XLINK}}}href")).lstrip("#")
        value = definitions.get(reference)
        if value:
            components[value[0]] = value[1]
    street = components.get("ThoroughfareName", "")
    postcode = components.get("PostalDescriptor", "")
    admin_unit = components.get("AdminUnitName", "")
    if not street or not POSTCODE_PATTERN.fullmatch(postcode):
        return None
    if normalized_name(admin_unit) != normalized_name(municipality):
        return None
    record_id = f"catastro-address:{local_identifier}"
    return {
        "id": record_id,
        "source_record_id": record_id,
        "source_dataset": "Spanish Directorate General for Cadastre INSPIRE",
        "country": "ES",
        "admin1": province,
        "admin1_code": province_code,
        "locality": municipality,
        "district": "",
        "postal_city": municipality,
        "address_levels": [province, municipality],
        "postcode": postcode,
        "street": street,
        "number": number,
        "unit": "",
        "latitude": latitude,
        "longitude": longitude,
        "property_type": "residential",
        "residential_building_id": f"catastro-building:{cadastral_reference}",
        "residential_building_class": "residential",
        "residential_evidence": "currentUse=1_residential;numberOfDwellings>0",
        "municipality_code": municipality_code,
        "source_language": "esp",
    }


def select_records(records, maximum):
    heap = []
    sequence = 0
    seen = set()
    for record in records:
        if not record:
            continue
        identity = (record["number"].casefold(), record["street"].casefold(), record["postcode"])
        if identity in seen:
            continue
        seen.add(identity)
        digest = int.from_bytes(hashlib.sha256(record["source_record_id"].encode("utf-8")).digest(), "big")
        item = (-digest, sequence, record)
        sequence += 1
        if len(heap) < maximum:
            heapq.heappush(heap, item)
        elif item > heap[0]:
            heapq.heapreplace(heap, item)
    return [record for _, _, record in sorted(heap, key=lambda item: (-item[0], item[1]))]


def export(addresses_path, buildings_path, output_path, maximum, province, province_code,
           municipality, municipality_code):
    with zipfile.ZipFile(addresses_path) as addresses_archive, zipfile.ZipFile(buildings_path) as buildings_archive:
        address_member = archive_member(addresses_archive, ".gml")
        building_member = archive_member(buildings_archive, ".building.gml")
        residential = residential_buildings(buildings_archive, building_member)
        definitions = component_definitions(addresses_archive, address_member)
        records = select_records((
            address_record(element, definitions, residential, province, province_code,
                           municipality, municipality_code)
            for element in iter_features(addresses_archive, address_member, "Address")
        ), maximum)
    output = pathlib.Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.name}.tmp")
    with open(temporary, "w", encoding="utf-8", newline="\n") as destination:
        for record in records:
            destination.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        destination.flush()
        os.fsync(destination.fileno())
    os.replace(temporary, output)
    return {"accepted": len(records), "residentialBuildings": len(residential),
            "componentDefinitions": len(definitions)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--addresses-archive", required=True)
    parser.add_argument("--buildings-archive", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-records", required=True, type=int)
    parser.add_argument("--province", required=True)
    parser.add_argument("--province-code", required=True)
    parser.add_argument("--municipality", required=True)
    parser.add_argument("--municipality-code", required=True)
    args = parser.parse_args()
    print(json.dumps(export(args.addresses_archive, args.buildings_archive, args.output,
                            args.max_records, args.province, args.province_code,
                            args.municipality, args.municipality_code), separators=(",", ":")))


if __name__ == "__main__":
    main()
