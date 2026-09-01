import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "south-africa-ethekwini-export.py"
SPEC = importlib.util.spec_from_file_location("south_africa_ethekwini_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SouthAfricaEthekwiniExportTest(unittest.TestCase):
    def test_skips_a_zoning_request_after_retries_are_exhausted(self):
        value = {"longitude": 31.0, "latitude": -29.8}
        with mock.patch.object(MODULE, "residential_zoning", side_effect=OSError("temporary")):
            self.assertIsNone(MODULE.verified_record(value, "https://example.test/zoning"))

    def test_resolves_only_exact_unique_official_street_postcode(self):
        content = (
            '"PlaceName","StrCode","Town"\n'
            '"GLENWOOD","4001","DURBAN"\n'
            '"GLENWOOD","4001","DURBAN"\n'
            '"GLENWOOD","9999","OTHER"\n'
            '"AMBIGUOUS","1111","DURBAN"\n'
            '"AMBIGUOUS","2222","DURBAN"\n'
        )
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", delete=False) as source:
            source.write(content)
            path = source.name
        try:
            postcodes = MODULE.load_postcodes(path)
            self.assertEqual(MODULE.resolve_postcode(postcodes, "Glenwood", "Durban"), "4001")
            self.assertEqual(MODULE.resolve_postcode(postcodes, "Glenwood", "Other Town"), "")
            self.assertEqual(MODULE.resolve_postcode(postcodes, "Ambiguous", "Durban"), "")
        finally:
            pathlib.Path(path).unlink(missing_ok=True)

    def test_rejects_numeric_road_names_and_nonstandard_numbers(self):
        self.assertIsNone(MODULE.valid_address({
            "STRNUM": "2", "STRNAME": "74002", "STRTYPE": "TRACK",
            "SUBURB": "EKWANDENI", "DISTRICT": "ILANGA"
        }))
        self.assertIsNone(MODULE.valid_address({
            "STRNUM": "12-14", "STRNAME": "MAIN", "STRTYPE": "ROAD",
            "SUBURB": "GLENWOOD", "DISTRICT": "DURBAN"
        }))
        self.assertEqual(MODULE.valid_address({
            "STRNUM": "40", "STRNAME": "LABURNUM", "STRTYPE": "ROAD",
            "SUBURB": "GLENWOOD", "DISTRICT": "DURBAN"
        }), ("40", "LABURNUM ROAD", "GLENWOOD", "DURBAN"))

    def test_emits_explicit_official_residential_evidence(self):
        value = {
            "object_id": "112662", "number": "40", "street": "LABURNUM ROAD",
            "suburb": "GLENWOOD", "district": "DURBAN", "postcode": "4001",
            "longitude": 30.9941, "latitude": -29.8688
        }
        original = MODULE.residential_zoning
        MODULE.residential_zoning = lambda *_: ("173957", "SPECIAL RESIDENTIAL 400")
        try:
            record = MODULE.verified_record(value, "https://example.test/zoning")
        finally:
            MODULE.residential_zoning = original
        self.assertEqual(record["property_type"], "residential")
        self.assertEqual(record["residential_building_class"], "residential")
        self.assertEqual(record["residential_building_id"], "ethekwini-zoning:173957")
        self.assertEqual(record["postcode"], "4001")


if __name__ == "__main__":
    unittest.main()
