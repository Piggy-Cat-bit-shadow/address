import importlib
import importlib.util
import json
import math
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


STUBS = {
    "duckdb": {"connect": None},
    "osmium": {"FileProcessor": None},
    "osmium.filter": {"KeyFilter": None},
    "shapely": {"Polygon": None, "STRtree": None, "from_wkb": None, "points": None},
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
    def test_candidate_store_uses_bounded_resources_and_chunked_inserts(self):
        connection = open_store()
        settings = connection.execute(
            "SELECT current_setting('threads'), current_setting('preserve_insertion_order'), "
            "current_setting('memory_limit'), current_setting('temp_directory')"
        ).fetchone()
        self.assertEqual(settings[:3], (2, False, "3.7 GiB"))
        self.assertTrue(settings[3].endswith(".duckdb.tmp"))
        constraints = connection.execute(
            "SELECT constraint_type, constraint_column_names FROM duckdb_constraints() "
            "WHERE table_name='candidates'"
        ).fetchall()
        self.assertIn(("PRIMARY KEY", ["id"]), constraints)
        self.assertNotIn(("UNIQUE", ["source_id"]), constraints)
        candidates = [{
            "source_id": f"abr/chunk-{index}", "prefecture": "東京都", "city": "fixture",
            "district": "district", "street": "street", "number": f"{index}番1号",
            "postcode": "1000001", "longitude": 139.7, "latitude": 35.6,
            "source_rank": index
        } for index in range(1201)]
        MODULE.insert_candidates(connection, candidates)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 1201)

    def test_candidate_store_handles_two_million_rows_with_64_mib(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(MODULE, "DUCKDB_MEMORY_LIMIT", "64MB"):
            connection = MODULE.open_candidate_store(pathlib.Path(directory) / "candidates.duckdb")
            try:
                connection.execute("""
                    INSERT INTO candidates(source_id,prefecture,city,district,street,number,postcode,
                      longitude,latitude,source_rank)
                    SELECT 'abr/stress-' || lpad(i::VARCHAR, 7, '0'), '東京都', 'fixture',
                      'district', 'street', '1番1号', '1000001', 139.7, 35.6, i
                    FROM range(2000000) rows(i)
                """)
                self.assertEqual(
                    connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 2_000_000
                )
            finally:
                connection.close()

    def test_city_candidate_import_bounds_transaction_memory_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(MODULE, "DUCKDB_MEMORY_LIMIT", "64MB"):
            connection = MODULE.open_candidate_store(pathlib.Path(directory) / "candidates.duckdb")
            candidates = [{
                "source_id": f"abr/city-stress-{index}", "prefecture": "東京都", "city": "fixture",
                "district": "district", "street": "street", "number": f"{index}番1号",
                "postcode": "1000001", "longitude": 139.7, "latitude": 35.6, "source_rank": index
            } for index in range(20_000)]
            MODULE.insert_city_candidates(connection, ("東京都", "fixture", "000001"), candidates)
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM candidates WHERE prefecture='東京都' AND city='fixture'"
            ).fetchone()[0], 20_000)
            MODULE.insert_city_candidates(connection, ("東京都", "fixture", "000001"), candidates[:1_000])
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM candidates WHERE prefecture='東京都' AND city='fixture'"
            ).fetchone()[0], 1_000)
            self.assertEqual(connection.execute(
                "SELECT city_key FROM abr_city_commits"
            ).fetchone()[0], "000001\x1f東京都\x1ffixture")
            connection.close()

    def test_plateau_matching_uses_spatial_index_and_persists_chunk_progress(self):
        from shapely import Polygon

        connection = open_store()
        for index, (longitude, latitude) in enumerate(((139.7000, 35.6000), (139.7100, 35.6100))):
            connection.execute(
                "INSERT INTO candidates(source_id,prefecture,city,district,street,number,postcode,"
                "longitude,latitude,source_rank) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (f"abr/spatial-{index}", "東京都", "fixture", "district", "street", "1", "1000001",
                 longitude, latitude, index))
        with tempfile.TemporaryDirectory() as directory:
            parquet = pathlib.Path(directory) / "buildings.parquet"
            source = MODULE.duckdb.connect()
            source.execute("CREATE TABLE buildings(building_uid TEXT,usage TEXT,geometry BLOB)")
            source.executemany("INSERT INTO buildings VALUES (?,?,?)", [
                ("inside-a", "residential", Polygon([(139.69, 35.59), (139.705, 35.59),
                                                       (139.705, 35.605), (139.69, 35.605)]).wkb),
                ("inside-b", "residential", Polygon([(139.705, 35.605), (139.72, 35.605),
                                                       (139.72, 35.62), (139.705, 35.62)]).wkb),
            ])
            source.execute("COPY buildings TO ? (FORMAT PARQUET)", [str(parquet)])
            source.close()
            progress = []
            matched = MODULE.match_plateau_buildings(
                connection, parquet, progress=lambda offset, count: progress.append((offset, count))
            )
        rows = connection.execute("SELECT building_id FROM candidates ORDER BY id").fetchall()
        self.assertEqual(matched, 2)
        self.assertEqual(rows, [("plateau/inside-a",), ("plateau/inside-b",)])
        self.assertEqual(progress[-1], (2, 2))

    def test_atomic_checkpoint_round_trip_preserves_resume_cursor(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint_path = pathlib.Path(directory) / "checkpoint.json"
            expected = {"version": 1, "abr_complete": True, "abr_completed_cities": ["13101"],
                        "plateau_completed": ["13101"], "plateau_building_completed": ["13101"],
                        "plateau_offsets": {"13102": 20000},
                        "osm_scanned_ways": 99999, "osm_complete": False, "final_complete": False}
            MODULE.write_checkpoint(checkpoint_path, expected)
            self.assertEqual(MODULE.load_checkpoint(checkpoint_path), expected)
            self.assertFalse(list(checkpoint_path.parent.glob("*.tmp")))

    def test_legacy_checkpoint_adds_independent_plateau_building_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint_path = pathlib.Path(directory) / "checkpoint.json"
            checkpoint_path.write_text(json.dumps({
                "version": 1, "abr_complete": True, "abr_completed_cities": [],
                "plateau_completed": [], "plateau_offsets": {"01100": 365907},
                "osm_scanned_ways": 0, "osm_complete": False, "final_complete": False
            }), encoding="utf-8")
            checkpoint = MODULE.load_checkpoint(checkpoint_path)
            self.assertEqual(checkpoint["plateau_building_completed"], [])

    def test_city_parser_keeps_only_the_best_deterministic_candidates(self):
        rows = [f"{index},1,,139.{index:03d},35.600" for index in range(1, 31)]
        payload = ("住居表示,神南一丁目\nblk_num,rsdt_num,rsdt_num2,lng,lat\n"
                   + "\n".join(rows)).encode("utf-8")
        arguments = ("https://example.test", "東京都", "渋谷区", {}, 7)
        with patch.object(MODULE, "request_bytes", return_value=payload), \
                patch.object(MODULE, "postcode_for", return_value="1500041"):
            first = MODULE.parse_city(arguments)
            second = MODULE.parse_city(arguments)
            complete = MODULE.parse_city((*arguments[:4], None))
        self.assertEqual(len(first), 7)
        self.assertEqual([row["source_id"] for row in first], [row["source_id"] for row in second])
        self.assertEqual([row["source_id"] for row in first], [row["source_id"] for row in complete[:7]])
        self.assertEqual([row["source_rank"] for row in first], sorted(row["source_rank"] for row in first))

    def test_city_parser_deduplicates_repeated_source_rows(self):
        row = "1,2,,139.700,35.600"
        payload = ("住居表示,神南一丁目\nblk_num,rsdt_num,rsdt_num2,lng,lat\n"
                   + "\n".join((row, row))).encode("utf-8")
        with patch.object(MODULE, "request_bytes", return_value=payload), \
                patch.object(MODULE, "postcode_for", return_value="1500041"):
            candidates = MODULE.parse_city(("https://example.test", "東京都", "渋谷区", {}, None))
        self.assertEqual(len(candidates), 1)

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
