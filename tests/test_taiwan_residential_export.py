import csv
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import zipfile
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "taiwan-residential-export.py"
SPEC = importlib.util.spec_from_file_location("taiwan_residential_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TaiwanResidentialExportTest(unittest.TestCase):
    def test_accepts_only_explicit_residential_transactions(self):
        headers = ["鄉鎮市區", "交易標的", "土地位置建物門牌", "建物型態", "主要用途", "編號"]
        rows = [
            ["大安區", "房地(土地+建物)", "臺北市大安區愛國東路２１６號三樓", "住宅大樓(11層含以上有電梯)", "住家用", "A1"],
            ["大安區", "房地(土地+建物)", "臺北市大安區愛國東路218號", "辦公商業大樓", "辦公室", "A2"],
            ["大安區", "車位", "臺北市大安區愛國東路220號", "其他", "住家用", "A3"],
        ]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            archive_path = pathlib.Path(directory) / "molit.zip"
            value = io.StringIO()
            writer = csv.writer(value)
            writer.writerow(headers)
            writer.writerow(["english"] * len(headers))
            writer.writerows(rows)
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("a_lvr_land_a.csv", value.getvalue().encode("utf-8-sig"))
            candidates = MODULE.load_molit_candidates(archive_path)
        self.assertEqual(list(candidates), ["臺北市大安區愛國東路216號"])
        self.assertEqual(candidates["臺北市大安區愛國東路216號"]["residentialClass"], "apartments")

    def test_merges_quarters_and_deduplicates_normalized_addresses(self):
        headers = ["鄉鎮市區", "交易標的", "土地位置建物門牌", "建物型態", "主要用途", "編號"]

        def archive(path, rows):
            value = io.StringIO()
            writer = csv.writer(value)
            writer.writerow(headers)
            writer.writerow(["english"] * len(headers))
            writer.writerows(rows)
            with zipfile.ZipFile(path, "w") as output:
                output.writestr("a_lvr_land_a.csv", value.getvalue().encode("utf-8-sig"))

        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            latest = pathlib.Path(directory) / "latest.zip"
            previous = pathlib.Path(directory) / "previous.zip"
            archive(latest, [
                ["大安區", "房地(土地+建物)", "臺北市大安區愛國東路２１６號三樓", "住宅大樓", "住家用", "NEW"],
            ])
            archive(previous, [
                ["大安區", "房地(土地+建物)", "台北市大安區愛國東路216號二樓", "公寓", "住家用", "OLD"],
                ["大安區", "房地(土地+建物)", "臺北市大安區愛國東路218號", "公寓", "住家用", "OLD-ONLY"],
            ])
            candidates = MODULE.load_molit_candidates([latest, previous])

        self.assertEqual(list(candidates), ["臺北市大安區愛國東路216號", "臺北市大安區愛國東路218號"])
        self.assertEqual(candidates["臺北市大安區愛國東路216號"]["sourceRecordId"], "NEW")

    def test_requires_exact_official_postcode_address_and_coordinates(self):
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        values = [
            {
                "address": "臺北市大安區愛國東路216號", "longitude": 121.52, "latitude": 25.03,
                "use": "住家用", "kind": "住宅大樓(11層含以上有電梯)",
                "postcode": "106201", "postalAddress": "臺北市大安區愛國東路216號", "postalExact": True,
            },
            {
                "address": "臺北市大安區愛國東路218號", "longitude": 121.52, "latitude": 25.03,
                "use": "住家用", "kind": "住宅大樓(11層含以上有電梯)",
                "postcode": "106201", "postalAddress": "臺北市大安區愛國東路216號", "postalExact": False,
            },
            {
                "address": "臺北市大安區愛國東路220號", "longitude": 10, "latitude": 10,
                "use": "住家用", "kind": "住宅大樓(11層含以上有電梯)",
                "postcode": "106201", "postalAddress": "臺北市大安區愛國東路220號", "postalExact": True,
            },
        ]
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            source = pathlib.Path(directory) / "verified.jsonl"
            source.write_text("\n".join(json.dumps(value, ensure_ascii=False) for value in values), encoding="utf-8")
            records = MODULE.load_verified_jsonl(source)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["postcode"], "106201")
        self.assertEqual(records[0]["street"], "愛國東路")
        self.assertEqual(records[0]["number"], "216")

    def test_uses_only_unique_openaddresses_point_matches(self):
        candidates = {
            "臺北市大安區愛國東路216號": {
                "address": "臺北市大安區愛國東路216號", "admin1": "臺北市", "locality": "大安區",
                "street": "愛國東路", "number": "216", "residentialClass": "apartments",
            }
        }
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            archive_path = pathlib.Path(directory) / "oa.zip"
            value = io.StringIO()
            writer = csv.DictWriter(value, fieldnames=["LON", "LAT", "NUMBER", "STREET", "CITY", "REGION"])
            writer.writeheader()
            writer.writerow({"LON": 121.52, "LAT": 25.03, "NUMBER": 216, "STREET": "愛國東路",
                             "CITY": "大安區", "REGION": "臺北市"})
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("tw/tpe/regionwide.csv", value.getvalue())
            points = MODULE.load_oa_points(archive_path, candidates)
        self.assertEqual(points["臺北市大安區愛國東路216號"][:2], (121.52, 25.03))

    def test_rejects_a_point_that_has_multiple_conflicting_coordinates(self):
        candidates = {
            "臺北市大安區愛國東路216號": {
                "address": "臺北市大安區愛國東路216號", "admin1": "臺北市", "locality": "大安區",
                "street": "愛國東路", "number": "216", "residentialClass": "apartments",
            }
        }
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            archive_path = pathlib.Path(directory) / "oa.zip"
            value = io.StringIO()
            writer = csv.DictWriter(value, fieldnames=["LON", "LAT", "NUMBER", "STREET", "CITY", "REGION"])
            writer.writeheader()
            for longitude in (121.52, 121.53, 121.54):
                writer.writerow({"LON": longitude, "LAT": 25.03, "NUMBER": 216, "STREET": "愛國東路",
                                 "CITY": "大安區", "REGION": "臺北市"})
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("tw/tpe/regionwide.csv", value.getvalue())
            points = MODULE.load_oa_points(archive_path, candidates)
        self.assertNotIn("臺北市大安區愛國東路216號", points)

    def test_retries_transient_cached_postcode_failures(self):
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        address = "臺北市大安區愛國東路216號"
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache_file = pathlib.Path(directory) / "postcodes.jsonl"
            cache = {address: {"address": address, "status": 429, "postcode": ""}}
            result = {
                "address": address, "status": 200, "postcode": "106201",
                "postalAddress": address, "postalExact": True,
            }
            with mock.patch.object(MODULE, "postal_lookup", return_value=result) as lookup:
                postcodes = MODULE.verified_postcodes([address], cache, cache_file, 0, 1)
        self.assertEqual(postcodes[address], "106201")
        lookup.assert_called_once_with(address)

    def test_parallel_postcode_results_are_written_as_complete_json_lines(self):
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        addresses = [
            "臺北市大安區愛國東路216號",
            "臺北市大安區愛國東路218號",
        ]

        def result(address):
            return {
                "address": address, "status": 200, "postcode": "106201",
                "postalAddress": address, "postalExact": True,
            }

        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache_file = pathlib.Path(directory) / "postcodes.jsonl"
            with mock.patch.object(MODULE, "postal_lookup", side_effect=result):
                resolved = MODULE.verified_postcodes(addresses, {}, cache_file, 0, 2)
            lines = [json.loads(line) for line in cache_file.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(resolved, {address: "106201" for address in addresses})
        self.assertEqual([line["address"] for line in lines], addresses)


if __name__ == "__main__":
    unittest.main()
