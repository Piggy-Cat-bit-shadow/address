import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "korea-kapt-export.py"
if "pyproj" not in sys.modules:
    try:
        import pyproj  # noqa: F401
    except ModuleNotFoundError:
        sys.modules["pyproj"] = types.SimpleNamespace(Transformer=object)
SPEC = importlib.util.spec_from_file_location("korea_kapt_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FixedTransformer:
    def transform(self, _x, _y):
        return 126.977, 37.574


class KoreaKaptExportTest(unittest.TestCase):
    def test_catalog_cli_writes_a_stable_snapshot_without_geocoding(self):
        rows = [{
            "kaptCode": code,
            "kaptName": name,
            "bjdName": "서울특별시 종로구 내수동",
            "bun1": number,
            "bun2": "0000",
            "addr": f"서울특별시 종로구 내수동 {int(number)}",
            "x": 197438.363,
            "y": 452451.605,
        } for code, name, number in (("A2", "두번째", "0002"), ("A1", "첫번째", "0001"))]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            first = pathlib.Path(directory) / "first.jsonl"
            second = pathlib.Path(directory) / "second.jsonl"
            clients = [
                types.SimpleNamespace(apartments=lambda: iter(rows)),
                types.SimpleNamespace(apartments=lambda: iter(reversed(rows))),
            ]
            with patch.object(MODULE, "KaptClient", side_effect=clients), \
                    patch.object(MODULE, "Transformer", types.SimpleNamespace(
                        from_crs=lambda *_args, **_kwargs: FixedTransformer())), \
                    patch.object(MODULE, "reverse_postcode") as reverse:
                with patch.object(sys, "argv", ["korea-kapt-export.py", "--catalog-output", str(first)]):
                    MODULE.main()
                with patch.object(sys, "argv", ["korea-kapt-export.py", "--catalog-output", str(second)]):
                    MODULE.main()
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual([json.loads(line)["source_record_id"]
                              for line in first.read_text(encoding="utf-8").splitlines()], ["kapt:A1", "kapt:A2"])
            reverse.assert_not_called()

    def test_full_export_cli_reuses_catalog_and_writes_partial_resume_state(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "admin1": "서울특별시",
            "locality": "종로구",
            "district": "내수동",
            "address_levels": ["서울특별시", "종로구", "내수동"],
            "latitude": 37.5,
            "longitude": 127.0 + index / 1000,
            "source_rank": str(index),
        } for index in range(2)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            root = pathlib.Path(directory)
            catalog = root / "catalog.jsonl"
            output = root / "output.jsonl"
            cache = root / "postcodes.jsonl"
            state = root / "state.json"
            MODULE.write_catalog(catalog, values)
            argv = ["korea-kapt-export.py", "--output", str(output), "--catalog-input", str(catalog),
                    "--postcode-cache", str(cache), "--state-output", str(state),
                    "--max-records", "2", "--per-locality", "2", "--minimum-interval", "0",
                    "--geocode-concurrency", "1"]
            with patch.object(sys, "argv", argv), \
                    patch.object(MODULE, "KaptClient", side_effect=AssertionError("catalog must be reused")), \
                    patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", side_effect=[
                        "03174", MODULE.GeocodeUnavailable("quota exhausted")
                    ]):
                MODULE.main()
            exported = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            saved_state = json.loads(state.read_text(encoding="utf-8"))
            self.assertEqual(len(exported), 1)
            self.assertEqual(saved_state["candidate_count"], 2)
            self.assertEqual(saved_state["resolved_count"], 1)
            self.assertEqual(saved_state["publishable_count"], 1)
            self.assertFalse(saved_state["source_complete"])
            self.assertTrue(saved_state["checkpoint_token"])
            self.assertEqual(saved_state["catalog_fingerprint"],
                             MODULE.hashlib.sha256(catalog.read_bytes()).hexdigest())

    def test_full_export_cli_writes_state_when_quota_stops_before_the_first_result(self):
        value = {
            "source_record_id": "kapt:1", "admin1": "서울특별시", "locality": "종로구", "district": "내수동",
            "address_levels": ["서울특별시", "종로구", "내수동"], "latitude": 37.5, "longitude": 127.0,
            "source_rank": "1",
        }
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            root = pathlib.Path(directory)
            catalog, output = root / "catalog.jsonl", root / "output.jsonl"
            cache, state = root / "postcodes.jsonl", root / "state.json"
            MODULE.write_catalog(catalog, [value])
            argv = ["korea-kapt-export.py", "--output", str(output), "--catalog-input", str(catalog),
                    "--postcode-cache", str(cache), "--state-output", str(state),
                    "--max-records", "1", "--per-locality", "1", "--minimum-interval", "0"]
            with patch.object(sys, "argv", argv), \
                    patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", side_effect=MODULE.GeocodeUnavailable("quota exhausted")):
                MODULE.main()
            saved_state = json.loads(state.read_text(encoding="utf-8"))
            self.assertEqual(output.read_text(encoding="utf-8"), "")
            self.assertFalse(saved_state["source_complete"])
            self.assertEqual(saved_state["resolved_count"], 0)
            self.assertTrue(saved_state["checkpoint_token"])

    def test_retries_transient_bridge_connection_errors(self):
        value = {
            "latitude": 37.5,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        }
        response = io.BytesIO(json.dumps({"results": [{
            "country_code": "kr", "state": "서울특별시", "postcode": "03000"
        }]}).encode("utf-8"))
        with patch.object(MODULE.urllib.request, "urlopen",
                          side_effect=[urllib.error.URLError("reset"), response]), \
                patch.object(MODULE.time, "sleep") as sleep:
            self.assertEqual(MODULE.reverse_postcode(value, "http://127.0.0.1/bridge"), "03000")
        sleep.assert_called_once_with(0.25)

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

    def test_persists_definitive_results_without_a_fixed_daily_limit(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "latitude": 37.5 + index / 1000,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        } for index in range(3)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as reverse:
                output = list(MODULE.add_postcodes(values, str(cache), 0, 1))
            self.assertEqual(len(output), 3)
            self.assertEqual(reverse.call_count, 3)
            entries = [json.loads(line) for line in cache.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(entries), 3)
            results = [entry for entry in entries if entry["event"] == "result"]
            self.assertEqual(len(results), 3)
            self.assertTrue(all(entry["postcode"] == "03174" for entry in results))

    def test_transient_credential_failure_does_not_poison_the_cache(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "latitude": 37.5,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        } for index in range(3)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", side_effect=MODULE.GeocodeUnavailable) as reverse:
                with self.assertRaises(MODULE.GeocodeUnavailable):
                    list(MODULE.add_postcodes(values, str(cache), 0, 3))
            self.assertEqual(reverse.call_count, 3)
            self.assertEqual(cache.read_text(encoding="utf-8"), "")
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as retry:
                self.assertEqual(len(list(MODULE.add_postcodes(values, str(cache), 0, 1))), 3)
            self.assertEqual(retry.call_count, 3)

    def test_quota_exhaustion_returns_cached_results_with_a_resume_checkpoint(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "latitude": 37.5,
            "longitude": 127.0 + index / 1000,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        } for index in range(3)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", side_effect=[
                        "03174", MODULE.GeocodeUnavailable("quota exhausted")
                    ]):
                batch = MODULE.add_postcodes(values, str(cache), 0, 1)
            self.assertFalse(batch.source_complete)
            self.assertTrue(batch.checkpoint_token)
            self.assertEqual([value["source_record_id"] for value in batch], ["kapt:0"])

            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03175") as retry:
                resumed = MODULE.add_postcodes(values, str(cache), 0, 1)
            self.assertTrue(resumed.source_complete)
            self.assertEqual(retry.call_count, 2)
            self.assertEqual(len(resumed), 3)

    def test_legacy_found_postcode_is_revalidated_before_publication(self):
        value = {
            "source_record_id": "kapt:legacy",
            "latitude": 37.5,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        }
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            cache.write_text(json.dumps({
                "id": "kapt:legacy", "postcode": "00000", "requested_on": "2026-01-01"
            }) + "\n", encoding="utf-8")
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as reverse:
                batch = MODULE.add_postcodes([value], str(cache), 0, 1)
            self.assertEqual(reverse.call_count, 1)
            self.assertEqual([entry["postcode"] for entry in batch], ["03174"])
            self.assertTrue(batch.source_complete)

    def test_single_bridge_failure_skips_only_that_record(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "latitude": 37.5,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        } for index in range(3)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", side_effect=[
                        MODULE.BridgeUnavailable("temporary"), "03174", "03174"
                    ]):
                output = list(MODULE.add_postcodes(values, str(cache), 0, 1))
            self.assertEqual([value["source_record_id"] for value in output], ["kapt:1", "kapt:2"])
            self.assertNotIn("kapt:0", cache.read_text(encoding="utf-8"))

    def test_repeated_bridge_failures_stop_after_a_bounded_threshold(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "latitude": 37.5,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        } for index in range(3)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "MAX_CONSECUTIVE_BRIDGE_FAILURES", 2), \
                    patch.object(MODULE, "reverse_postcode", side_effect=MODULE.BridgeUnavailable("temporary")) as reverse:
                with self.assertRaises(MODULE.BridgeUnavailable):
                    list(MODULE.add_postcodes(values, str(cache), 0, 1))
            self.assertEqual(reverse.call_count, 2)
            self.assertEqual(cache.read_text(encoding="utf-8"), "")

    def test_definitive_negative_results_are_cached_until_the_candidate_changes(self):
        values = [{
            "source_record_id": f"kapt:{index}",
            "latitude": 37.5,
            "longitude": 127.0,
            "address_levels": ["서울특별시", "종로구", "내수동"],
        } for index in range(3)]
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache = pathlib.Path(directory) / "postcodes.jsonl"
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", return_value=None) as reverse:
                self.assertEqual(list(MODULE.add_postcodes(values, str(cache), 0, 3)), [])
            self.assertEqual(reverse.call_count, 3)
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as retry:
                self.assertEqual(list(MODULE.add_postcodes(values, str(cache), 0, 3)), [])
            self.assertEqual(retry.call_count, 0)

            changed = [{**value, "longitude": value["longitude"] + 0.01}
                       if value["source_record_id"] == "kapt:0" else value for value in values]
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as changed_retry:
                self.assertEqual(len(MODULE.add_postcodes(changed, str(cache), 0, 3)), 1)
            self.assertEqual(changed_retry.call_count, 1)

            entries = [json.loads(line) for line in cache.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([entry["result"] for entry in entries], ["not_found", "not_found", "not_found", "found"])
            self.assertTrue(all(entry["candidate_fingerprint"] for entry in entries))
            for entry in entries:
                entry["requested_on"] = "2026-01-01"
            cache.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as later_retry:
                self.assertEqual(len(MODULE.add_postcodes(values, str(cache), 0, 3)), 1)
            self.assertEqual(later_retry.call_count, 1)

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
            with patch.dict(MODULE.os.environ, {"ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL": "http://127.0.0.1/bridge"}), \
                    patch.object(MODULE, "reverse_postcode", return_value="03174") as reverse:
                output = list(MODULE.add_postcodes([value, value], str(cache), 0, 2))
            self.assertEqual(reverse.call_count, 1)
            self.assertEqual(len(output), 2)


if __name__ == "__main__":
    unittest.main()
