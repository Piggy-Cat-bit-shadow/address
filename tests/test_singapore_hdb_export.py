import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "singapore-hdb-export.py"
SPEC = importlib.util.spec_from_file_location("singapore_hdb_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SingaporeHdbExportTest(unittest.TestCase):
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
