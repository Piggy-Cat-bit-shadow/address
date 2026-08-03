import importlib.util
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "south-africa-cape-town-export.py"
SPEC = importlib.util.spec_from_file_location("south_africa_cape_town_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SouthAfricaCapeTownExportTest(unittest.TestCase):
    def test_resolves_only_one_exact_official_postal_pair(self):
        content = (
            '"PlaceName","StrCode","Town"\n'
            '"KOMMETJIE","7975","FISH HOEK"\n'
            '"KOMMETJIE","7975","FISH HOEK"\n'
            '"DUPLICATE","1111","TOWN A"\n'
            '"DUPLICATE","2222","TOWN B"\n'
        )
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", delete=False) as source:
            source.write(content)
            path = source.name
        try:
            postcodes = MODULE.load_postcodes(path)
            self.assertEqual(MODULE.resolve_postcode(postcodes, "Kommetjie"), ("FISH HOEK", "7975"))
            self.assertIsNone(MODULE.resolve_postcode(postcodes, "Duplicate"))
            self.assertIsNone(MODULE.resolve_postcode(postcodes, "Missing"))
        finally:
            pathlib.Path(path).unlink(missing_ok=True)

    def test_requires_complete_standard_official_address_fields(self):
        valid = {
            "ADR_NO": 12, "ADR_NO_SFX": "A", "STR_NAME": "Diemar",
            "LU_STR_NAME_TYPE": "Road", "OFC_SBRB_NAME": "Kommetjie",
            "ZONING": "Residential 1 : Conventional Housing",
        }
        self.assertEqual(MODULE.valid_address(valid), (
            "12A", "DIEMAR ROAD", "KOMMETJIE", "RESIDENTIAL 1 : CONVENTIONAL HOUSING",
        ))
        self.assertIsNone(MODULE.valid_address({**valid, "STR_NAME": "74002"}))
        self.assertIsNone(MODULE.valid_address({**valid, "LU_STR_NAME_TYPE": None}))
        self.assertIsNone(MODULE.valid_address({**valid, "OFC_SBRB_NAME": None}))

    def test_rejects_mixed_or_non_residential_zoning(self):
        base = {
            "ADR_NO": 12, "ADR_NO_SFX": None, "STR_NAME": "Diemar",
            "LU_STR_NAME_TYPE": "Road", "OFC_SBRB_NAME": "Kommetjie",
        }
        self.assertIsNone(MODULE.valid_address({
            **base, "ZONING": "Mixed Use 1",
        }))
        self.assertIsNone(MODULE.valid_address({
            **base,
            "ZONING": "Residential 1 : Conventional Housing,Transport 2 : Public Road and Public Parking",
        }))

    def test_rejects_coordinates_outside_cape_town(self):
        feature = {
            "centroid": {"x": 30.99, "y": -29.86},
            "attributes": {
                "OBJECTID": 1, "ADR_NO": 2, "ADR_NO_SFX": None, "STR_NAME": "Surf",
                "LU_STR_NAME_TYPE": "Way", "OFC_SBRB_NAME": "Kommetjie",
                "ZONING": "Residential 1 : Conventional Housing",
            },
        }
        self.assertIsNone(MODULE.record(feature, {"KOMMETJIE": {("FISH HOEK", "7975")}}))

    def test_emits_same_parcel_residential_evidence(self):
        feature = {
            "centroid": {"x": 18.327995, "y": -34.137418},
            "attributes": {
                "OBJECTID": 421, "ADR_NO": 2, "ADR_NO_SFX": None, "STR_NAME": "Surf",
                "LU_STR_NAME_TYPE": "Way", "OFC_SBRB_NAME": "Kommetjie",
                "ZONING": "Residential 1 : Conventional Housing",
            },
        }
        record = MODULE.record(feature, {"KOMMETJIE": {("FISH HOEK", "7975")}})
        self.assertEqual(record["admin1"], "Western Cape")
        self.assertEqual(record["locality"], "FISH HOEK")
        self.assertEqual(record["district"], "KOMMETJIE")
        self.assertEqual(record["postcode"], "7975")
        self.assertEqual(record["residential_building_id"], "cape-town-parcel:421")
        self.assertEqual(record["residential_evidence"], "RESIDENTIAL 1 : CONVENTIONAL HOUSING")


if __name__ == "__main__":
    unittest.main()
