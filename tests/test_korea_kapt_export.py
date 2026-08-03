import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "korea-kapt-export.py"
SPEC = importlib.util.spec_from_file_location("korea_kapt_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FixedTransformer:
    def transform(self, _x, _y):
        return 126.977, 37.574


class KoreaKaptExportTest(unittest.TestCase):
    def test_parses_official_land_lot_address_without_generating_units(self):
        row = {
            "kaptCode": "A11087101",
            "kaptName": "경희궁의아침2단지",
            "bjdName": "서울특별시 종로구 내수동",
            "bun1": "0071",
            "bun2": "0000",
            "addr": "서울특별시 종로구 내수동 71 ",
            "x": 197438.363,
            "y": 452451.605,
        }
        value = MODULE.candidate(row, FixedTransformer())
        self.assertEqual(value["admin1"], "서울특별시")
        self.assertEqual(value["locality"], "종로구")
        self.assertEqual(value["district"], "내수동")
        self.assertEqual(value["street"], "내수동")
        self.assertEqual(value["number"], "71")
        self.assertEqual(value["building_name"], "경희궁의아침2단지")
        self.assertNotIn("unit", value)

    def test_validates_reverse_postcode_administrative_hierarchy(self):
        valid = {
            "country_code": "kr",
            "state": "서울",
            "district": "종로구",
            "suburb": "내수동",
        }
        wrong = {**valid, "state": "부산", "city": "부산"}
        hierarchy = ["서울특별시", "종로구", "내수동"]
        self.assertTrue(MODULE.geoapify_matches_hierarchy(valid, hierarchy))
        self.assertFalse(MODULE.geoapify_matches_hierarchy(wrong, hierarchy))

    def test_preserves_four_level_land_lot_hierarchy(self):
        row = {
            "kaptCode": "A41111101",
            "kaptName": "정자마을",
            "bjdName": "경기도 수원시 장안구 정자동",
            "bun1": "0012",
            "bun2": "0003",
            "addr": "경기도 수원시 장안구 정자동 12-3 ",
            "x": 200000,
            "y": 400000,
        }
        value = MODULE.candidate(row, FixedTransformer())
        self.assertEqual(value["locality"], "수원시 장안구")
        self.assertEqual(value["district"], "정자동")
        self.assertEqual(value["street"], "정자동")
        self.assertEqual(value["number"], "12-3")

    def test_normalizes_compound_city_district_names_for_display(self):
        row = {
            "kaptCode": "A44133301",
            "kaptName": "북천안자이포레스트아파트",
            "bjdName": "충청남도 천안서북구 성거읍 송남리",
            "bun1": "0585",
            "bun2": "0000",
            "addr": "충청남도 천안서북구 성거읍 송남리 585",
            "x": 200000,
            "y": 400000,
        }
        value = MODULE.candidate(row, FixedTransformer())
        self.assertEqual(value["admin1"], "충청남도")
        self.assertEqual(value["locality"], "천안시 서북구 성거읍")
        self.assertEqual(value["district"], "송남리")
        self.assertEqual(value["address_levels"], ["충청남도", "천안시", "서북구", "성거읍", "송남리"])

    def test_persists_cache_and_stops_at_daily_limit(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "latitude": 37.5 + index / 1000,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        } for index in range(3)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"GEOAPIFY_API_KEY": "TEST_KEY"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as reverse:
                output = list(MODULE.add_postcodes(values, str(cache), 2, 0, 1))
            self.assertEqual(len(output), 2)
            self.assertEqual(reverse.call_count, 2)
            entries = [json.loads(line) for line in cache.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(entries), 4)
            results = [entry for entry in entries if entry["event"] == "result"]
            self.assertEqual(len(results), 2)
            self.assertTrue(all(entry["postcode"] == "03174" for entry in results))

    def test_stops_new_requests_after_quota_exhaustion(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "latitude": 37.5,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        } for index in range(3)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"GEOAPIFY_API_KEY": "TEST_KEY"}), \
                    patch.object(MODULE, "reverse_postcode", side_effect=MODULE.GeocodeQuotaExhausted) as reverse:
                self.assertEqual(list(MODULE.add_postcodes(values, str(cache), 3, 0, 3)), [])
            self.assertEqual(reverse.call_count, 3)
            self.assertEqual(len(cache.read_text(encoding="utf-8").splitlines()), 6)

    def test_accounts_for_all_inflight_requests_after_authentication_error(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "latitude": 37.5,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        } for index in range(3)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"GEOAPIFY_API_KEY": "TEST_KEY"}), \
                    patch.object(MODULE, "reverse_postcode", side_effect=RuntimeError("HTTP 401")) as reverse:
                with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                    list(MODULE.add_postcodes(values, str(cache), 3, 0, 3))
            self.assertEqual(reverse.call_count, 3)
            with patch.dict(MODULE.os.environ, {"GEOAPIFY_API_KEY": "TEST_KEY"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as retry:
                self.assertEqual(list(MODULE.add_postcodes(values, str(cache), 3, 0, 3)), [])
            self.assertEqual(retry.call_count, 0)

    def test_deduplicates_pending_record_ids(self):
        value = {
            "source_record_id": "kapt:duplicate",
            "latitude": 37.5,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        }
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"GEOAPIFY_API_KEY": "TEST_KEY"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as reverse:
                output = list(MODULE.add_postcodes([value, value], str(cache), 2, 0, 2))
            self.assertEqual(reverse.call_count, 1)
            self.assertEqual(len(output), 2)


if __name__ == "__main__":
    unittest.main()
