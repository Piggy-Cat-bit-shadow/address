import csv
import importlib.util
import io
import json
import zipfile
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "bdnb", Path(__file__).parents[1] / "server" / "sync" / "france-bdnb-export.py"
)
BDNB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BDNB)


def csv_text(fields, rows):
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fields, delimiter=";", lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def make_archive(path):
    usages = [
        {"batiment_groupe_id": "bg-a", "code_departement_insee": "23", "usage_principal_bdnb_open": "Résidentiel individuel"},
        {"batiment_groupe_id": "bg-b", "code_departement_insee": "23", "usage_principal_bdnb_open": "Résidentiel collectif"},
        {"batiment_groupe_id": "bg-c", "code_departement_insee": "23", "usage_principal_bdnb_open": "Résidentiel individuel"},
        {"batiment_groupe_id": "bg-x", "code_departement_insee": "23", "usage_principal_bdnb_open": "Tertiaire"},
    ]
    relations = [
        {"WKT": "", "batiment_groupe_id": "bg-a", "cle_interop_adr": "23001_0005_00001", "code_departement_insee": "23", "origine": "Association Geometrique", "fiabilite": "17"},
        {"WKT": "", "batiment_groupe_id": "bg-b", "cle_interop_adr": "23002_0005_00002", "code_departement_insee": "23", "origine": "Association Geometrique", "fiabilite": "20"},
        {"WKT": "", "batiment_groupe_id": "bg-c", "cle_interop_adr": "23003_0005_00003", "code_departement_insee": "23", "origine": "Association Geometrique", "fiabilite": "16"},
        {"WKT": "", "batiment_groupe_id": "bg-x", "cle_interop_adr": "23004_0005_00004", "code_departement_insee": "23", "origine": "Association Geometrique", "fiabilite": "20"},
    ]
    address_template = {
        "WKT": "POINT (626206.1 6554508.1)", "code_departement_insee": "23",
        "rep": "", "type_voie": "rue", "nom_voie": "de la mairie",
        "libelle_adresse": "", "code_postal": "23150", "source": "BAN",
    }
    addresses = [
        {**address_template, "cle_interop_adr": "23001_0005_00001", "numero": "1", "code_commune_insee": "23001", "libelle_commune": "Ahun"},
        {**address_template, "cle_interop_adr": "23002_0005_00002", "numero": "2", "rep": "BIS", "type_voie": "", "code_commune_insee": "23002", "libelle_commune": "Ajain"},
        {**address_template, "cle_interop_adr": "23003_0005_00003", "numero": "3", "code_commune_insee": "23003", "libelle_commune": "Alleyrat"},
        {**address_template, "cle_interop_adr": "23004_0005_00004", "numero": "4", "code_commune_insee": "23004", "libelle_commune": "Anzême"},
    ]
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(BDNB.USAGE_MEMBER, csv_text(list(usages[0]), usages))
        archive.writestr(BDNB.RELATION_MEMBER, csv_text(list(relations[0]), relations))
        archive.writestr(BDNB.ADDRESS_MEMBER, csv_text(list(addresses[0]), addresses))


def test_export_joins_ban_to_strict_residential_buildings(tmp_path):
    archive = tmp_path / "bdnb.zip"
    output = tmp_path / "addresses.jsonl"
    make_archive(archive)
    result = BDNB.export(archive, output, maximum=10, per_locality=10, minimum_fiability=17)
    records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert result == {
        "residential_buildings": 3, "strict_address_keys": 2,
        "publishable": 2, "selected": 2, "communes": 2,
    }
    assert {record["id"] for record in records} == {
        "bdnb-ban:23001_0005_00001", "bdnb-ban:23002_0005_00002"
    }
    assert {record["property_type"] for record in records} == {"residential", "apartment"}
    assert all(record["admin1"] == "Nouvelle-Aquitaine" for record in records)
    assert all(record["district"] == "Creuse" for record in records)
    assert all(-6 <= record["longitude"] <= 10 and 41 <= record["latitude"] <= 52 for record in records)
    assert next(record for record in records if record["locality"] == "Ajain")["number"] == "2 bis"


def test_lambert93_conversion_matches_reference_point():
    longitude, latitude = BDNB.lambert93_to_wgs84(652469.022709, 6862035.259420)
    assert abs(longitude - 2.3522) < 0.0002
    assert abs(latitude - 48.8566) < 0.0002
