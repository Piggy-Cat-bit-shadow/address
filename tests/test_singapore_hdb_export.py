import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "singapore-hdb-export.py"
SPEC = importlib.util.spec_from_file_location("singapore_hdb_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SingaporeHdbExportTest(unittest.TestCase):
    def test_legacy_null_cache_is_rechecked_because_it_may_be_a_transient_failure(self):
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache_file = pathlib.Path(directory) / "onemap.jsonl"
            cache_file.write_text(json.dumps({"query": "1 TEST ROAD", "result": None}) + "\n", encoding="utf-8")
            cache = MODULE.load_onemap_cache(cache_file)
            response = io.BytesIO(json.dumps({"results": []}).encode("utf-8"))
            with patch.object(MODULE.urllib.request, "urlopen", return_value=response) as request:
                result = MODULE.onemap_result(
                    {"blk_no": "1", "street": "TEST ROAD"}, "http://127.0.0.1/bridge", cache, cache_file, 0
                )
            self.assertIsNone(result)
            self.assertEqual(cache["1 TEST ROAD"]["status"], "not_found")
            request.assert_called_once()

    def test_quota_failure_does_not_poison_the_cache(self):
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            cache_file = pathlib.Path(directory) / "onemap.jsonl"
            body = io.BytesIO(json.dumps({
                "code": "SOURCE_QUOTA_UNAVAILABLE", "nextAvailableAt": "2026-08-11T00:00:00Z"
            }).encode("utf-8"))
            error = urllib.error.HTTPError("http://127.0.0.1/bridge", 503, "unavailable", {}, body)
            with patch.object(MODULE.urllib.request, "urlopen", side_effect=error):
                with self.assertRaises(MODULE.TemporaryOnemapFailure) as raised:
                    MODULE.onemap_result(
                        {"blk_no": "1", "street": "TEST ROAD"},
                        "http://127.0.0.1/bridge", {}, cache_file, 0
                    )
            self.assertEqual(raised.exception.kind, "quota")
            self.assertEqual(raised.exception.next_available_at, "2026-08-11T00:00:00Z")
            self.assertFalse(cache_file.exists())

    def test_records_preserve_official_results_when_onemap_is_partial(self):
        properties = {
            ("1", "A"): [{"blk_no": "1", "street": "ALPHA ROAD", "bldg_contract_town": "AMK"}],
            ("2", "B"): [{"blk_no": "2", "street": "BETA ROAD", "bldg_contract_town": "BD"}],
        }
        buildings = {
            ("2", "B"): [({"ENTITYID": "official", "OBJECTID": "2", "POSTAL_COD": "460002"}, 103.9, 1.3)]
        }
        with patch.object(MODULE, "load_properties", return_value=properties), \
                patch.object(MODULE, "load_buildings", return_value=buildings), \
                patch.object(MODULE, "load_onemap_cache", return_value={}), \
                patch.object(MODULE, "onemap_result",
                             side_effect=MODULE.TemporaryOnemapFailure("credential", "2026-08-11T00:00:00Z")):
            batch = MODULE.records("properties.csv", "buildings.json", "cache.jsonl",
                                   "http://127.0.0.1/bridge", 0)
        self.assertFalse(batch.source_complete)
        self.assertTrue(batch.checkpoint_token)
        self.assertEqual(batch.temporary_failure, "credential")
        self.assertEqual(batch.next_available_at, "2026-08-11T00:00:00Z")
        self.assertEqual(batch.candidate_count, 2)
        self.assertEqual(batch.resolved_count, 1)
        self.assertEqual([value["postcode"] for value in batch], ["460002"])

    def test_cli_writes_partial_checkpoint_state_atomically(self):
        value = {
            "id": "hdb-building:official:2", "postcode": "460002", "locality": "Bedok",
            "street": "BETA ROAD", "number": "2",
        }
        batch = MODULE.RecordBatch([value], False, "checkpoint-1", 2, 1,
                                   "network", "2026-08-11T00:00:00Z")
        pathlib.Path(".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".data-cache") as directory:
            root = pathlib.Path(directory)
            output, state = root / "output.jsonl", root / "state.json"
            argv = ["singapore-hdb-export.py", "--property-csv", "properties.csv",
                    "--building-geojson", "buildings.json", "--output", str(output),
                    "--onemap-cache", str(root / "cache.jsonl"),
                    "--onemap-bridge-url", "http://127.0.0.1/bridge", "--state-output", str(state),
                    "--max-records", "10", "--per-locality", "10"]
            with patch.object(sys, "argv", argv), patch.object(MODULE, "records", return_value=batch):
                MODULE.main()
            saved = json.loads(state.read_text(encoding="utf-8"))
            self.assertFalse(saved["source_complete"])
            self.assertEqual(saved["checkpoint_token"], "checkpoint-1")
            self.assertEqual(saved["temporary_failure"], "network")
            self.assertEqual(saved["next_available_at"], "2026-08-11T00:00:00Z")
            self.assertEqual(len(output.read_text(encoding="utf-8").splitlines()), 1)
            self.assertFalse(list(root.glob("state.json.*.tmp")))

    def test_prefers_official_building_when_onemap_resolves_to_same_postcode(self):
        common = {
            "postcode": "200026", "locality": "Kallang/Whampoa",
            "street": "BENDEMEER RD", "number": "26",
        }
        onemap = {**common, "id": "hdb-building:onemap:200026", "street": "JLN BERSEH"}
        official = {**common, "id": "hdb-building:3740:943709"}
        selected = MODULE.select_balanced([onemap, official], 10, 10)
        self.assertEqual(selected, [official])


if __name__ == "__main__":
    unittest.main()
