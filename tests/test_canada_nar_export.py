import csv
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "server" / "sync"))
import importlib.util

SPEC = importlib.util.spec_from_file_location("nar", Path(__file__).parents[1] / "server" / "sync" / "canada-nar-export.py")
NAR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NAR)


def make_archive(path):
    location_fields = ["LOC_GUID", "CSD_CODE", "BG_LATITUDE", "BG_LONGITUDE"]
    address_fields = ["LOC_GUID", "ADDR_GUID", "APT_NO_LABEL", "CIVIC_NO", "CIVIC_NO_SUFFIX",
                      "OFFICIAL_STREET_NAME", "OFFICIAL_STREET_TYPE", "OFFICIAL_STREET_DIR",
                      "PROV_CODE", "CSD_ENG_NAME", "CSD_FRE_NAME", "MAIL_MUN_NAME",
                      "MAIL_PROV_ABVN", "MAIL_POSTAL_CODE", "BU_USE"]
    locations = [
        {"LOC_GUID": "loc-a", "CSD_CODE": "3500001", "BG_LATITUDE": "43.65", "BG_LONGITUDE": "-79.38"},
        {"LOC_GUID": "loc-b", "CSD_CODE": "2400001", "BG_LATITUDE": "46.81", "BG_LONGITUDE": "-71.21"},
    ]
    addresses = [
        {"LOC_GUID": "loc-a", "ADDR_GUID": "addr-a", "APT_NO_LABEL": "2", "CIVIC_NO": "10",
         "CIVIC_NO_SUFFIX": "A", "OFFICIAL_STREET_NAME": "King", "OFFICIAL_STREET_TYPE": "ST",
         "OFFICIAL_STREET_DIR": "W", "PROV_CODE": "35", "CSD_ENG_NAME": "Toronto",
         "CSD_FRE_NAME": "Toronto", "MAIL_MUN_NAME": "Toronto", "MAIL_PROV_ABVN": "ON",
         "MAIL_POSTAL_CODE": "M5V 1A1", "BU_USE": "1"},
        {"LOC_GUID": "loc-b", "ADDR_GUID": "addr-b", "APT_NO_LABEL": "", "CIVIC_NO": "20",
         "CIVIC_NO_SUFFIX": "", "OFFICIAL_STREET_NAME": "Rue Saint", "OFFICIAL_STREET_TYPE": "ST",
         "OFFICIAL_STREET_DIR": "", "PROV_CODE": "24", "CSD_ENG_NAME": "Quebec",
         "CSD_FRE_NAME": "Québec", "MAIL_MUN_NAME": "Quebec", "MAIL_PROV_ABVN": "QC",
         "MAIL_POSTAL_CODE": "G1A1A1", "BU_USE": "2"},
        {"LOC_GUID": "loc-a", "ADDR_GUID": "addr-c", "APT_NO_LABEL": "", "CIVIC_NO": "30",
         "CIVIC_NO_SUFFIX": "", "OFFICIAL_STREET_NAME": "Nonres", "OFFICIAL_STREET_TYPE": "RD",
         "OFFICIAL_STREET_DIR": "", "PROV_CODE": "35", "CSD_ENG_NAME": "Toronto",
         "CSD_FRE_NAME": "Toronto", "MAIL_MUN_NAME": "Toronto", "MAIL_PROV_ABVN": "ON",
         "MAIL_POSTAL_CODE": "M5V1A1", "BU_USE": "3"},
    ]
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, fields, rows in [
            ("Locations/Location_35.csv", location_fields, locations),
            ("Locations/Location_24.csv", location_fields, locations[1:]),
            ("Addresses/Address_35.csv", address_fields, [addresses[0], addresses[2]]),
            ("Addresses/Address_24.csv", address_fields, [addresses[1]]),
        ]:
            lines = []
            output = __import__("io").StringIO()
            writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
            archive.writestr(name, output.getvalue())


def test_local_nar_export_filters_and_joins(tmp_path):
    archive = tmp_path / "nar.zip"
    make_archive(archive)
    source = NAR.LocalZipSource(archive)
    output = tmp_path / "out.jsonl"
    checkpoint = tmp_path / "state" / "checkpoint.json"
    result = NAR.export(source, output, checkpoint, 10, 10)
    values = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert result["accepted"] == 2
    assert {value["id"] for value in values} == {"statcan-nar:addr-a", "statcan-nar:addr-b"}
    assert values[0]["postcode"] in {"M5V 1A1", "G1A 1A1"}
    assert all("latitude" in value and "longitude" in value for value in values)
    assert not checkpoint.exists()


def test_member_pattern_handles_multipart_names(tmp_path):
    archive = tmp_path / "nar.zip"
    make_archive(archive)
    source = NAR.LocalZipSource(archive)
    assert NAR.province_members(source, "Addresses", "35") == ["Addresses/Address_35.csv"]
    assert NAR.province_members(source, "Locations", "24") == ["Locations/Location_24.csv"]
