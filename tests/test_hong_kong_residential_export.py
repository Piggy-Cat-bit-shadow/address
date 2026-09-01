import csv
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import zipfile
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "hong-kong-residential-export.py"
SPEC = importlib.util.spec_from_file_location("hong_kong_residential_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


PRIVATE_ROW = {
    "OBJECTID": "55",
    "ADDRESS_E": "THE HILLGROVE ALDER BLK A1 9 TSING FAT LANE",
    "ADDRESS_C": "漣山A1 屯門 青發里9號",
    "SEARCH1_E": "Tuen Mun",
    "SEARCH1_C": "屯門區",
    "SEARCH2_E": "New Territories",
    "SEARCH2_C": "新界",
    "NSEARCH1_E": "5216950",
    "NSEARCH4_E": "Tower",
    "NSEARCH5_E": "Residential/Composite",
    "LATITUDE": "22.36599593",
    "LONGITUDE": "114.0007247",
}

HOUSING_ROW = {
    "estate_english_name": "CHUN SHEK ESTATE",
    "estate_chinese_name": "秦石邨",
    "district_english_name": "SHA TIN",
    "district_chinese_name": "沙田",
    "region_english_name": "NEW TERRITORIES EAST",
    "region_chinese_name": "新界東",
    "english_name_of_block": "SHEK FAI HOUSE",
    "chinese_name_of_block": "石暉樓",
    "flat_number": "1001",
    "floor_number": "10",
    "estate_map_latitude": 22.37367,
    "estate_map_longitude": 114.18704,
}

ALS_XML = b"""<AddressLookupResult><SuggestedAddress><Address><PremisesAddress>
<EngPremisesAddress><BuildingName>SHEK FAI HSE</BuildingName><EngEstate><EstateName>CHUN SHEK ESTATE</EstateName></EngEstate><EngStreet><LocationName>SHA TIN</LocationName><StreetName>SHING TIN STREET</StreetName><BuildingNoFrom>1</BuildingNoFrom></EngStreet><EngDistrict><DcDistrict>SHA TIN DISTRICT</DcDistrict></EngDistrict><Region>NT</Region></EngPremisesAddress>
<ChiPremisesAddress><Region>\xe6\x96\xb0\xe7\x95\x8c</Region><ChiDistrict><DcDistrict>\xe6\xb2\x99\xe7\x94\xb0\xe5\x8d\x80</DcDistrict></ChiDistrict><ChiStreet><LocationName>\xe6\xb2\x99\xe7\x94\xb0</LocationName><StreetName>\xe7\x9b\x9b\xe7\x94\xb0\xe8\xa1\x97</StreetName><BuildingNoFrom>1</BuildingNoFrom></ChiStreet><ChiEstate><EstateName>\xe7\xa7\xa6\xe7\x9f\xb3\xe9\x82\xa8</EstateName></ChiEstate><BuildingName>\xe7\x9f\xb3\xe6\x9a\x89\xe6\xa8\x93</BuildingName></ChiPremisesAddress>
<GeoAddress>3718626068T20050430</GeoAddress><GeospatialInformation><Latitude>22.3738</Latitude><Longitude>114.18579</Longitude></GeospatialInformation>
</PremisesAddress></Address></SuggestedAddress></AddressLookupResult>"""


class HongKongResidentialExportTest(unittest.TestCase):
    def test_accepts_only_official_residential_towers_with_matching_bilingual_address(self):
        value = MODULE.private_candidate(PRIVATE_ROW)
        self.assertEqual(value["locality"], "屯門區 Tuen Mun District")
        self.assertEqual(value["street"], "青發里 TSING FAT LANE")
        self.assertEqual(value["number"], "9")
        self.assertEqual(value["building_name"], "")
        self.assertEqual(value["residential_building_id"], "hk-bd-block:5216950")
        self.assertNotIn("postcode", value)
        for replacement in (
            {"NSEARCH5_E": "Office/Commercial"},
            {"NSEARCH4_E": "Podium"},
            {"SEARCH1_E": "Out Of District", "SEARCH1_C": "區外"},
            {"ADDRESS_E": "THE HILLGROVE"},
            {"LONGITUDE": "10"},
            {"ADDRESS_C": "英皇道2號及天后廟道3號", "ADDRESS_E": "2 KING'S RD & 3 TIN HAU TEMPLE RD"},
            {"ADDRESS_C": "ALPEXIIICENTRALPEAK1期司徒拔道18號", "ADDRESS_E": "Block 3 18 STUBBS RD"},
        ):
            self.assertIsNone(MODULE.private_candidate({**PRIVATE_ROW, **replacement}))

        island = MODULE.private_candidate({
            **PRIVATE_ROW,
            "SEARCH1_E": "Southern",
            "SEARCH1_C": "南區",
            "SEARCH2_E": "Hong Kong",
            "SEARCH2_C": "香港島",
        })
        self.assertEqual(island["admin1"], "香港島 Hong Kong")

    def test_reads_building_department_csv_from_zip(self):
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            path = pathlib.Path(directory) / "buildings.zip"
            text = io.StringIO()
            writer = csv.DictWriter(text, fieldnames=list(PRIVATE_ROW))
            writer.writeheader()
            writer.writerow(PRIVATE_ROW)
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("buildings.csv", text.getvalue().encode("utf-8-sig"))
            values = list(MODULE.private_records([path]))
        self.assertEqual(len(values), 1)
        self.assertEqual(values[0]["official_address"], PRIVATE_ROW["ADDRESS_C"])

    def test_requires_unique_exact_als_building_estate_and_district_match(self):
        value = MODULE.parse_als_xml(ALS_XML, HOUSING_ROW)
        self.assertEqual(value["geo_address"], "3718626068T20050430")
        self.assertEqual(value["street_chinese"], "盛田街")
        wrong = {**HOUSING_ROW, "chinese_name_of_block": "石晶樓"}
        self.assertIsNone(MODULE.parse_als_xml(ALS_XML, wrong))
        suggestion = ALS_XML.split(b"<SuggestedAddress>", 1)[1].split(b"</SuggestedAddress>", 1)[0]
        conflicting = suggestion.replace(b"3718626068T20050430", b"DIFFERENT-GEO-ADDRESS").replace(
            b"<BuildingNoFrom>1</BuildingNoFrom>", b"<BuildingNoFrom>2</BuildingNoFrom>"
        )
        ambiguous = b"<AddressLookupResult><SuggestedAddress>" + suggestion + b"</SuggestedAddress><SuggestedAddress>" + conflicting + b"</SuggestedAddress></AddressLookupResult>"
        self.assertIsNone(MODULE.parse_als_xml(ambiguous, HOUSING_ROW))

    def test_emits_real_floor_and_flat_without_generating_fields(self):
        address = MODULE.parse_als_xml(ALS_XML, HOUSING_ROW)
        value = MODULE.housing_candidate(HOUSING_ROW, address)
        self.assertEqual(value["street"], "盛田街 SHING TIN STREET")
        self.assertEqual(value["number"], "1")
        self.assertEqual(value["building_name"], "石暉樓 SHEK FAI HSE")
        self.assertEqual(value["unit"], "10樓1001室 10/F Flat 1001")
        self.assertEqual(value["floor"], "10")
        self.assertEqual(value["longitude"], 114.18579)
        self.assertNotIn("postcode", value)
        self.assertIsNone(MODULE.housing_candidate({**HOUSING_ROW, "flat_number": ""}, address))
        self.assertIsNone(MODULE.housing_candidate({**HOUSING_ROW, "estate_map_longitude": 113.9}, address))
        self.assertIsNone(MODULE.housing_candidate({**HOUSING_ROW, "region_chinese_name": "九龍東"}, address))

    def test_uses_cache_offline_and_never_promotes_unmatched_rows(self):
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        address = MODULE.parse_als_xml(ALS_XML, HOUSING_ROW)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            housing = pathlib.Path(directory) / "housing.json"
            cache = pathlib.Path(directory) / "als.jsonl"
            housing.write_text(json.dumps({"records": [HOUSING_ROW]}, ensure_ascii=False), encoding="utf-8")
            cache.write_text(json.dumps({"key": MODULE.als_cache_key(HOUSING_ROW), "result": address}, ensure_ascii=False) + "\n", encoding="utf-8")
            values = list(MODULE.housing_records([housing], cache, offline=True))
        self.assertEqual(len(values), 1)

    def test_rechecks_a_negative_als_cache_once_per_run(self):
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            housing = pathlib.Path(directory) / "housing.json"
            cache = pathlib.Path(directory) / "als.jsonl"
            housing.write_text(json.dumps({
                "records": [HOUSING_ROW, {**HOUSING_ROW, "flat_number": "1002"}]
            }, ensure_ascii=False), encoding="utf-8")
            cache.write_text(json.dumps({
                "key": MODULE.als_cache_key(HOUSING_ROW), "result": None
            }, ensure_ascii=False) + "\n", encoding="utf-8")
            with mock.patch.object(MODULE, "als_lookup", return_value=None) as lookup:
                values = list(MODULE.housing_records([housing], cache, request_interval=0))
        self.assertEqual(values, [])
        lookup.assert_called_once()

    def test_deduplicates_and_round_robins_districts(self):
        values = []
        for district in ("A", "B", "C"):
            for index in range(3):
                values.append({
                    "id": f"{district}-{index}", "locality": district,
                    "dedupe_key": f"{district}-{index}", "source_rank": str(index),
                })
        values.append({"id": "duplicate", "locality": "A", "dedupe_key": "A-0", "source_rank": "9"})
        selected = MODULE.select_balanced(values, 5, 2)
        self.assertEqual([value["locality"] for value in selected], ["A", "B", "C", "A", "B"])
        self.assertEqual(len({value["id"] for value in selected}), 5)
        self.assertTrue(all("source_rank" not in value and "dedupe_key" not in value for value in selected))


if __name__ == "__main__":
    unittest.main()
