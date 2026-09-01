import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "thailand-dpt-export.py"
SPEC = importlib.util.spec_from_file_location("thailand_dpt_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def feature(identifier="1", province="กรุงเทพมหานคร", amphoe="เขตบางรัก", tambon="แขวงสีลม",
            number="12/3", road="ถนนสีลม", postcode="10500", residence="BL_CLASS17"):
    return {
        "attributes": {
            "OBJECTID": int(identifier), "BL_ID": identifier, "BL_HOUSENUM": number,
            "BL_ROAD": road, "BL_TAMBOL": tambon, "BL_AMPHOE": amphoe,
            "BL_CHANGWAT": province, "BL_POSTCODE": postcode,
            "BL_CLASS17": 0, "BL_CLASS18": 0, "BL_CLASS20": 0,
            "BL_CLASS22": 0, "BL_CLASS54": 0, residence: 1,
        },
        "geometry": {"rings": [[[100.50, 13.70], [100.51, 13.70], [100.51, 13.71],
                                  [100.50, 13.71], [100.50, 13.70]]]},
    }


class ThailandDptExportTest(unittest.TestCase):
    def test_server_side_query_requires_every_publishable_address_field(self):
        self.assertIn("BL_CLASS17 = 1", MODULE.EXPORT_WHERE)
        for field in ("BL_ID", "BL_HOUSENUM", "BL_ROAD", "BL_TAMBOL", "BL_AMPHOE", "BL_CHANGWAT", "BL_POSTCODE"):
            self.assertIn(f"{field} IS NOT NULL", MODULE.EXPORT_WHERE)

    def test_maps_residential_categories_and_emits_thai_hierarchy(self):
        value = MODULE.record(feature(residence="BL_CLASS20"))
        self.assertEqual(value["property_type"], "apartment")
        self.assertEqual(value["residential_building_class"], "apartment")
        self.assertEqual(value["address_levels"], ["กรุงเทพมหานคร", "เขตบางรัก", "แขวงสีลม"])
        self.assertEqual(value["residential_evidence"], "BL_CLASS20")
        dormitory = MODULE.record(feature(identifier="2", residence="BL_CLASS22"))
        self.assertEqual(dormitory["residential_building_class"], "dormitory")

    def test_rejects_incomplete_non_thai_and_invalid_postcode_records(self):
        self.assertIsNone(MODULE.record(feature(number="")))
        self.assertIsNone(MODULE.record(feature(road="")))
        self.assertIsNone(MODULE.record(feature(road="Silom Road")))
        self.assertIsNone(MODULE.record(feature(postcode="1050")))
        self.assertIsNone(MODULE.record(feature(number="house twelve")))

    def test_polygon_point_uses_an_interior_point_for_concave_ring(self):
        geometry = {"rings": [[[100, 10], [104, 10], [104, 11], [101, 11], [101, 14],
                                [100, 14], [100, 10]]]}
        point = MODULE.polygon_point(geometry)
        self.assertTrue(MODULE.point_in_ring(point, geometry["rings"][0]))
        self.assertTrue(97 <= point[0] <= 106 and 5 <= point[1] <= 21)

    def test_polygon_point_does_not_land_in_a_hole(self):
        geometry = {"rings": [
            [[100, 10], [104, 10], [104, 14], [100, 14], [100, 10]],
            [[101, 11], [103, 11], [103, 13], [101, 13], [101, 11]],
        ]}
        point = MODULE.polygon_point(geometry)
        self.assertTrue(MODULE.point_in_polygon(point, geometry["rings"]))

    def test_balances_provinces_and_localities_with_a_hard_quota(self):
        values = []
        provinces = ["จังหวัดเชียงใหม่", "จังหวัดภูเก็ต", "จังหวัดขอนแก่น"]
        for province_index, province in enumerate(provinces):
            for locality_index in range(2):
                for item_index in range(4):
                    value = MODULE.record(feature(
                        identifier=f"{province_index + 1}{locality_index}{item_index}",
                        province=province,
                        amphoe=f"อำเภอเมือง{locality_index}",
                        tambon=f"ตำบลกลาง{locality_index}",
                        number=str(item_index + 1),
                    ))
                    values.append(value)
        selected = MODULE.select_balanced(values, 9, 2)
        self.assertEqual(len(selected), 9)
        self.assertEqual({value["admin1"] for value in selected}, set(provinces))
        locality_counts = {}
        for value in selected:
            key = MODULE.locality_identity(value)
            locality_counts[key] = locality_counts.get(key, 0) + 1
        self.assertLessEqual(max(locality_counts.values()), 2)
        self.assertEqual(
            [value["source_record_id"] for value in selected],
            [value["source_record_id"] for value in MODULE.select_balanced(values, 9, 2)],
        )

    def test_deduplicates_same_address(self):
        first = MODULE.record(feature(identifier="1"))
        duplicate = MODULE.record(feature(identifier="2"))
        selected = MODULE.select_balanced([first, duplicate], 10, 10)
        self.assertEqual(len(selected), 1)

    def test_resumes_after_a_failed_batch_and_cleans_checkpoint_on_success(self):
        identifiers = [1, 2, 3, 4]
        calls = []

        def failing_features(_url, batch):
            calls.append(list(batch))
            if batch == [3, 4]:
                raise OSError("temporary")
            return [feature(str(value), number=str(value)) for value in batch]

        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "th.jsonl"
            checkpoint = pathlib.Path(directory) / "checkpoint.json"
            with mock.patch.object(MODULE, "object_ids", return_value=identifiers), \
                    mock.patch.object(MODULE, "building_features", side_effect=failing_features):
                with self.assertRaises(OSError):
                    MODULE.export("https://example.test/layer", output, 10, 10, 2, checkpoint)
            self.assertTrue(checkpoint.exists())
            self.assertEqual(json.loads(checkpoint.read_text(encoding="utf-8"))["next_offset"], 2)

            resumed_calls = []

            def resumed_features(_url, batch):
                resumed_calls.append(list(batch))
                return [feature(str(value), number=str(value)) for value in batch]

            with mock.patch.object(MODULE, "object_ids", return_value=identifiers), \
                    mock.patch.object(MODULE, "building_features", side_effect=resumed_features):
                result = MODULE.export("https://example.test/layer", output, 10, 10, 2, checkpoint)
            self.assertEqual(resumed_calls, [[3, 4]])
            self.assertEqual(result, {"accepted": 4, "candidates": 4, "scanned": 4})
            self.assertEqual(len(output.read_text(encoding="utf-8").splitlines()), 4)
            self.assertFalse(checkpoint.exists())
            self.assertFalse(pathlib.Path(f"{checkpoint}.candidates.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
