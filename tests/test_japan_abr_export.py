import importlib
import importlib.util
import math
import pathlib
import sys
import types
import unittest


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
SPEC = importlib.util.spec_from_file_location("japan_abr_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def open_store():
    return MODULE.open_candidate_store(":memory:")


def add_candidates(connection, prefecture, city, count, matched=True):
    for index in range(count):
        connection.execute(
            "INSERT INTO candidates(source_id,prefecture,city,district,street,number,postcode,"
            "longitude,latitude,source_rank,building_id,building_class,building_name) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"abr/{prefecture}-{city}-{index:04d}", prefecture, city, "district", "street",
             f"{index + 1}番1号", "1000001", 139.7, 35.6, index,
             f"way/{prefecture}-{city}-{index}" if matched else None,
             "house" if matched else None, ""))
    connection.commit()


class JapanAbrSelectRecordsTest(unittest.TestCase):
    def test_prefecture_soft_cap_redistributes_to_other_prefectures(self):
        connection = open_store()
        for city in ("a区", "b区", "c区", "d区", "e区"):
            add_candidates(connection, "東京都", city, 20)
        for prefecture in ("三重県", "京都府", "佐賀県", "兵庫県", "北海道", "千葉県"):
            add_candidates(connection, prefecture, f"{prefecture}市", 3)
        selected = MODULE.select_records(connection, 20, 100)
        counts = {}
        for row in selected:
            counts[row[1]] = counts.get(row[1], 0) + 1
        self.assertEqual(len(selected), 20)
        self.assertEqual(counts["東京都"], math.ceil(20 * 0.15))
        others = {prefecture: count for prefecture, count in counts.items() if prefecture != "東京都"}
        self.assertEqual(sum(others.values()), 17)
        self.assertTrue(all(count in (2, 3) for count in others.values()))

    def test_cap_overflows_when_other_prefectures_are_exhausted(self):
        connection = open_store()
        for city in ("a区", "b区", "c区", "d区", "e区"):
            add_candidates(connection, "東京都", city, 20)
        add_candidates(connection, "北海道", "札幌市", 3)
        selected = MODULE.select_records(connection, 10, 100)
        counts = {}
        for row in selected:
            counts[row[1]] = counts.get(row[1], 0) + 1
        self.assertEqual(len(selected), 10)
        self.assertEqual(counts["北海道"], 3)
        self.assertEqual(counts["東京都"], 7)

    def test_round_robin_and_per_locality_limit_hold_without_cap_pressure(self):
        connection = open_store()
        add_candidates(connection, "愛知県", "a市", 5)
        add_candidates(connection, "愛知県", "b市", 2)
        add_candidates(connection, "愛知県", "c市", 1)
        selected = MODULE.select_records(connection, 100, 3)
        order = [(row[2], row[9]) for row in selected]
        self.assertEqual(order, [
            ("a市", 0), ("b市", 0), ("c市", 0),
            ("a市", 1), ("b市", 1),
            ("a市", 2),
        ])

    def test_only_candidates_with_building_evidence_are_selected(self):
        connection = open_store()
        add_candidates(connection, "京都府", "京都市", 4, matched=True)
        add_candidates(connection, "奈良県", "奈良市", 6, matched=False)
        selected = MODULE.select_records(connection, 100, 100)
        self.assertEqual(len(selected), 4)
        self.assertTrue(all(row[1] == "京都府" and row[10] is not None for row in selected))


if __name__ == "__main__":
    unittest.main()
