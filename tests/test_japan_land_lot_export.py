import importlib
import importlib.util
import pathlib
import sys
import types
import unittest

HAS_SHAPELY = importlib.util.find_spec("shapely") is not None

STUBS = {
    "duckdb": {"connect": None},
    "osmium": {"FileProcessor": None},
    "osmium.filter": {"KeyFilter": None},
    "shapely": {"from_wkb": None, "intersects_xy": None, "prepare": None},
}
for name, attributes in STUBS.items():
    try:
        importlib.import_module(name)
    except ImportError:
        module = types.ModuleType(name)
        for key, value in attributes.items():
            setattr(module, key, value)
        sys.modules[name] = module
if "osmium.filter" in sys.modules:
    sys.modules["osmium"].filter = sys.modules["osmium.filter"]

MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "japan-abr-export.py"
SPEC = importlib.util.spec_from_file_location("japan_abr_export_land_lot", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def open_store():
    connection = MODULE.open_candidate_store(":memory:")
    return connection


def lot_text(rows, town="大宮南田尻町"):
    lines = [f"地番,{town}", "prc_num1,prc_num2,prc_num3,lng,lat"]
    lines.extend(rows)
    return "index-line,0,1\n" + "\n".join(lines) + "\n"


POSTCODES = {
    ("京都府", "京都市北区", "大宮南田尻町"): [("6038166", None, None)],
    ("京都府", "京都市北区", "紫野"): [("6038201", 1, 2)],
    ("京都府", "京都市北区", "多重町"): [("6030001", None, None), ("6030002", None, None)],
}


class LotCityMatchTest(unittest.TestCase):
    def test_exact_and_designated_city_ward_ranges(self):
        self.assertTrue(MODULE.lot_city_matches("13113", "13113", False))
        self.assertTrue(MODULE.lot_city_matches("01100", "01101", True))
        self.assertTrue(MODULE.lot_city_matches("01100", "01110", True))
        self.assertTrue(MODULE.lot_city_matches("40130", "40137", True))
        self.assertTrue(MODULE.lot_city_matches("27100", "27128", True))

    def test_rejects_neighbouring_cities_and_plain_municipalities(self):
        self.assertFalse(MODULE.lot_city_matches("13110", "13111", False))
        self.assertFalse(MODULE.lot_city_matches("14100", "14131", True))
        self.assertFalse(MODULE.lot_city_matches("40130", "40202", False))
        self.assertFalse(MODULE.lot_city_matches("01100", "01202", False))
        self.assertFalse(MODULE.lot_city_matches("", "01101", True))


class ParseLotSectionsTest(unittest.TestCase):
    def parse(self, rows, town="大宮南田尻町"):
        return MODULE.parse_lot_sections(lot_text(rows, town), "京都府", "京都市北区", POSTCODES)

    def test_requires_coordinates_and_digit_lot_numbers(self):
        lots = self.parse([
            "45,,,135.75,35.05",
            "46,2,,135.7501,35.0501",
            "47,,,,",
            "枝,1,,135.75,35.05",
            "48,1,3,135.75,35.05",
            "49,,,200.0,35.05",
        ])
        self.assertEqual([(lot["number"], lot["postcode"]) for lot in lots],
                         [("45番地", "6038166"), ("46番地2", "6038166")])
        self.assertEqual(lots[0]["street"], "大宮南田尻町")
        self.assertEqual(lots[0]["district"], "")
        self.assertTrue(lots[0]["source_id"].startswith("chiban/"))

    def test_duplicate_lot_numbers_keep_first_record(self):
        lots = self.parse(["45,,,135.75,35.05", "45,,,135.7502,35.0502"])
        self.assertEqual(len(lots), 1)
        self.assertEqual(lots[0]["longitude"], 135.75)

    def test_chome_towns_split_district_and_use_postal_range(self):
        lots = MODULE.parse_lot_sections(
            lot_text(["3,,,135.74,35.04"], town="紫野一丁目"), "京都府", "京都市北区", POSTCODES)
        self.assertEqual(len(lots), 1)
        self.assertEqual(lots[0]["district"], "紫野")
        self.assertEqual(lots[0]["street"], "紫野一丁目")
        self.assertEqual(lots[0]["postcode"], "6038201")

    def test_ambiguous_or_missing_postcodes_are_not_filled(self):
        ambiguous = MODULE.parse_lot_sections(
            lot_text(["1,,,135.75,35.05"], town="多重町"), "京都府", "京都市北区", POSTCODES)
        missing = MODULE.parse_lot_sections(
            lot_text(["1,,,135.75,35.05"], town="不明町"), "京都府", "京都市北区", POSTCODES)
        self.assertIsNone(ambiguous[0]["postcode"])
        self.assertIsNone(missing[0]["postcode"])


def make_lot(number, longitude, latitude, postcode="6038166"):
    return {
        "source_id": f"chiban/{number}-{longitude}-{latitude}",
        "prefecture": "京都府", "city": "京都市北区", "district": "",
        "street": "大宮南田尻町", "number": number, "postcode": postcode,
        "longitude": longitude, "latitude": latitude,
        "source_rank": MODULE.rank(f"{number}-{longitude}-{latitude}"),
    }


def square(minimum_longitude, minimum_latitude, size=0.001):
    from shapely.geometry import Polygon
    return Polygon([
        (minimum_longitude, minimum_latitude),
        (minimum_longitude + size, minimum_latitude),
        (minimum_longitude + size, minimum_latitude + size),
        (minimum_longitude, minimum_latitude + size),
    ]).wkb


@unittest.skipUnless(HAS_SHAPELY, "shapely is required for containment tests")
class MatchCityLotsTest(unittest.TestCase):
    def test_land_lot_inserts_commit_in_bounded_idempotent_batches(self):
        connection = open_store()
        rows = [(
            f"chiban/batch-{index}", "京都府", "京都市北区", "", "大宮南田尻町",
            f"{index + 1}番地", "6038166", 135.75, 35.05, index,
            f"plateau/batch-{index}", "residential", ""
        ) for index in range(1201)]

        class TrackingConnection:
            def __init__(self, wrapped):
                self.wrapped = wrapped
                self.commits = 0

            def execute(self, *args, **kwargs):
                return self.wrapped.execute(*args, **kwargs)

            def executemany(self, *args, **kwargs):
                return self.wrapped.executemany(*args, **kwargs)

            def commit(self):
                self.commits += 1
                return self.wrapped.commit()

            def rollback(self):
                return self.wrapped.rollback()

        tracked = TrackingConnection(connection)
        self.assertEqual(MODULE.insert_land_lot_candidates(tracked, rows, batch_size=500), 1201)
        self.assertEqual(tracked.commits, 3)
        self.assertEqual(MODULE.insert_land_lot_candidates(tracked, rows, batch_size=500), 0)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 1201)

    def test_land_lot_insert_resumes_after_a_failed_batch(self):
        connection = open_store()
        rows = [(
            f"chiban/resume-{index}", "京都府", "京都市北区", "", "大宮南田尻町",
            f"{index + 1}番地", "6038166", 135.75, 35.05, index,
            f"plateau/resume-{index}", "residential", ""
        ) for index in range(1001)]

        class FailSecondBatch:
            def __init__(self, wrapped):
                self.wrapped = wrapped
                self.batches = 0

            def execute(self, *args, **kwargs):
                return self.wrapped.execute(*args, **kwargs)

            def executemany(self, *args, **kwargs):
                self.batches += 1
                if self.batches == 2:
                    raise RuntimeError("fixture interrupted batch")
                return self.wrapped.executemany(*args, **kwargs)

            def commit(self):
                return self.wrapped.commit()

            def rollback(self):
                return self.wrapped.rollback()

        progress = []
        with self.assertRaisesRegex(RuntimeError, "fixture interrupted batch"):
            MODULE.insert_land_lot_candidates(
                FailSecondBatch(connection), rows, batch_size=500, progress=progress.append
            )
        self.assertEqual(progress, [500])
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 500)

        class TrackRetryBatches:
            def __init__(self, wrapped):
                self.wrapped = wrapped
                self.source_ids = []

            def execute(self, *args, **kwargs):
                return self.wrapped.execute(*args, **kwargs)

            def executemany(self, statement, values):
                self.source_ids.extend(value[0] for value in values)
                return self.wrapped.executemany(statement, values)

            def commit(self):
                return self.wrapped.commit()

            def rollback(self):
                return self.wrapped.rollback()

        retry = TrackRetryBatches(connection)
        retry_progress = []
        self.assertEqual(MODULE.insert_land_lot_candidates(
            retry, rows, batch_size=500, progress=retry_progress.append
        ), 501)
        self.assertEqual(retry.source_ids, [f"chiban/resume-{index}" for index in range(500, 1001)])
        self.assertEqual(retry_progress, [1000, 1001])
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 1001)

    def test_unique_residential_containment_inserts_candidate(self):
        connection = open_store()
        lots = [make_lot("45番地", 135.7505, 35.0505)]
        counts = MODULE.match_city_lots(
            connection, lots, [("B1", "residential", square(135.75, 35.05))], set())
        self.assertEqual(counts, {"lots": 1, "in_unique_building": 1, "building_unique": 1,
                                  "unclaimed": 1, "inserted": 1})
        row = connection.execute(
            "SELECT source_id,building_id,building_class,postcode FROM candidates").fetchone()
        self.assertEqual(row, (lots[0]["source_id"], "plateau/B1", "residential", "6038166"))

    def test_lot_inside_two_residential_buildings_is_rejected(self):
        connection = open_store()
        lots = [make_lot("45番地", 135.7505, 35.0505)]
        counts = MODULE.match_city_lots(connection, lots, [
            ("B1", "residential", square(135.75, 35.05)),
            ("B2", "residential", square(135.7501, 35.0501)),
        ], set())
        self.assertEqual(counts["in_unique_building"], 0)
        self.assertEqual(counts["inserted"], 0)

    def test_lot_overlapped_by_non_residential_building_is_rejected(self):
        connection = open_store()
        lots = [make_lot("45番地", 135.7505, 35.0505)]
        counts = MODULE.match_city_lots(connection, lots, [
            ("B1", "residential", square(135.75, 35.05)),
            ("B2", "commercial", square(135.7501, 35.0501)),
        ], set())
        self.assertEqual(counts["in_unique_building"], 0)
        self.assertEqual(counts["inserted"], 0)

    def test_building_containing_two_lots_is_rejected(self):
        connection = open_store()
        lots = [make_lot("45番地", 135.7504, 35.0505), make_lot("46番地", 135.7506, 35.0505)]
        counts = MODULE.match_city_lots(
            connection, lots, [("B1", "residential", square(135.75, 35.05))], set())
        self.assertEqual(counts["in_unique_building"], 2)
        self.assertEqual(counts["building_unique"], 0)
        self.assertEqual(counts["inserted"], 0)

    def test_building_claimed_by_residence_indication_candidate_is_skipped(self):
        connection = open_store()
        MODULE.insert_candidates(connection, [{
            "source_id": "abr/existing", "prefecture": "京都府", "city": "京都市北区",
            "district": "紫野", "street": "紫野一丁目", "number": "1番2号",
            "postcode": "6038201", "longitude": 135.7505, "latitude": 35.0505, "source_rank": 1,
        }])
        connection.execute("UPDATE candidates SET building_id='plateau/B1', building_class='residential'")
        claimed = {row[0] for row in connection.execute(
            "SELECT DISTINCT building_id FROM candidates WHERE building_id LIKE 'plateau/%'").fetchall()}
        counts = MODULE.match_city_lots(
            connection, [make_lot("45番地", 135.7505, 35.0506)],
            [("B1", "residential", square(135.75, 35.05))], claimed)
        self.assertEqual(counts["building_unique"], 1)
        self.assertEqual(counts["unclaimed"], 0)
        self.assertEqual(counts["inserted"], 0)

    def test_lot_without_unique_postcode_is_rejected_after_containment(self):
        connection = open_store()
        counts = MODULE.match_city_lots(
            connection, [make_lot("45番地", 135.7505, 35.0505, postcode=None)],
            [("B1", "residential", square(135.75, 35.05))], set())
        self.assertEqual(counts["unclaimed"], 1)
        self.assertEqual(counts["inserted"], 0)

    def test_merged_selection_interleaves_residence_and_land_lot_candidates(self):
        connection = open_store()
        MODULE.insert_candidates(connection, [{
            "source_id": f"abr/shibuya-{index}", "prefecture": "東京都", "city": "渋谷区",
            "district": "神南", "street": "神南一丁目", "number": f"{index + 1}番1号",
            "postcode": "1500041", "longitude": 139.7, "latitude": 35.66, "source_rank": index,
        } for index in range(3)])
        connection.execute("UPDATE candidates SET building_id='plateau/T'||id, building_class='residential'")
        MODULE.match_city_lots(connection, [
            make_lot("45番地", 135.7502, 35.0505),
            make_lot("46番地", 135.7522, 35.0505),
        ], [
            ("K1", "residential", square(135.75, 35.05)),
            ("K2", "residential", square(135.752, 35.05)),
        ], set())
        selected = MODULE.select_records(connection, 10, 2)
        cities = [row[2] for row in selected]
        self.assertEqual(len(selected), 4)
        self.assertEqual(sorted(set(cities)), ["京都市北区", "渋谷区"])
        self.assertEqual(cities.count("京都市北区"), 2)
        self.assertEqual(cities.count("渋谷区"), 2)
        numbers = {row[5] for row in selected if row[2] == "京都市北区"}
        self.assertEqual(numbers, {"45番地", "46番地"})


if __name__ == "__main__":
    unittest.main()
