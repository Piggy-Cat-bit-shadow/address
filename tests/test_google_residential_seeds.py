import importlib.util
import pathlib
import unittest
from types import SimpleNamespace


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "google-residential-seeds.py"
SPEC = importlib.util.spec_from_file_location("google_residential_seeds", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def way(identifier, longitude, latitude, address=False):
    ring = [
        (longitude - 0.001, latitude - 0.001),
        (longitude + 0.001, latitude - 0.001),
        (longitude + 0.001, latitude + 0.001),
        (longitude - 0.001, latitude + 0.001),
        (longitude - 0.001, latitude - 0.001)
    ]
    return SimpleNamespace(
        id=identifier,
        tags=[SimpleNamespace(k=key, v=value) for key, value in {
            "building": "house",
            **({"addr:housenumber": "18", "addr:street": "MG Road"} if address else {})
        }.items()],
        nodes=[SimpleNamespace(location=SimpleNamespace(
            lon=point[0], lat=point[1], valid=lambda: True
        )) for point in ring]
    )


class GoogleResidentialSeedTest(unittest.TestCase):
    def test_prioritizes_and_round_robins_administrative_gap_targets(self):
        sampler = MODULE.SeedSampler(3, None, None, [
            {"id": "city:1", "kind": "city", "priority": 0, "deficit": 5,
             "latitude": 0, "longitude": 0},
            {"id": "city:2", "kind": "city", "priority": 1, "deficit": 3,
             "latitude": 10, "longitude": 10}
        ])
        for value in [
            way(1, 0.01, 0.01), way(2, 10.01, 10.01),
            way(3, 0.02, 0.02), way(4, 10.02, 10.02)
        ]:
            sampler.way(value)

        selected = sampler.selected()
        self.assertEqual(len(selected), 3)
        self.assertEqual(
            [record["scheduling_hint"]["id"] for record in selected],
            ["city:1", "city:1", "city:2"]
        )
        self.assertEqual(len({record["id"] for record in selected}), 3)

    def test_uses_original_deterministic_sampling_without_targets(self):
        sampler = MODULE.SeedSampler(2, None, None)
        for value in [way(1, 0.01, 0.01), way(2, 1.01, 1.01), way(3, 2.01, 2.01)]:
            sampler.way(value)

        first = [record["id"] for record in sampler.selected()]
        self.assertEqual(len(first), 2)
        self.assertEqual(first, [record["id"] for record in sampler.selected()])

    def test_source_address_mode_keeps_only_addressed_residential_buildings(self):
        sampler = MODULE.SeedSampler(2, None, None, require_source_address=True)
        sampler.way(way(1, 77.219, 28.632))
        sampler.way(way(2, 77.220, 28.633, address=True))

        selected = sampler.selected()
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["number"], "18")
        self.assertEqual(selected[0]["street"], "MG Road")


if __name__ == "__main__":
    unittest.main()
