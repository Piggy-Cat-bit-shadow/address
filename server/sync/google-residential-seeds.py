import argparse
import hashlib
import heapq
import json
import math
import pathlib

try:
    import osmium
    from osmium.filter import KeyFilter
except ModuleNotFoundError:
    osmium = None
    KeyFilter = None
from shapely import contains_xy, intersects_xy, prepare
from shapely.geometry import LineString, Point, Polygon, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree


RESIDENTIAL_BUILDINGS = {
    "apartments", "bungalow", "cabin", "detached", "dormitory", "ger",
    "house", "residential", "semidetached_house", "terrace"
}
NON_RESIDENTIAL_POI_KEYS = {
    "amenity", "craft", "healthcare", "industrial", "leisure", "military",
    "office", "public_transport", "shop", "tourism"
}


class CompiledBoundary:
    def __init__(self, geometry):
        self.geometry = geometry
        polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
        holes = [LineString(ring.coords) for polygon in polygons for ring in polygon.interiors]
        self.hole_boundaries = unary_union(holes) if holes else None
        prepare(self.geometry)
        if self.hole_boundaries is not None:
            prepare(self.hole_boundaries)

    def contains(self, longitude, latitude):
        return bool(contains_xy(self.geometry, longitude, latitude) or (
            intersects_xy(self.geometry, longitude, latitude)
            and (self.hole_boundaries is None or not intersects_xy(self.hole_boundaries, longitude, latitude))
        ))


def boundary_from_geojson(path):
    if not path:
        return None
    document = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    features = document.get("features", [document]) if document.get("type") == "FeatureCollection" else [document]
    geometries = [shape(feature.get("geometry", feature)) for feature in features]
    return CompiledBoundary(unary_union([geometry for geometry in geometries if not geometry.is_empty]))


def rank(value):
    return int(hashlib.sha256(value.encode("utf-8")).hexdigest()[:16], 16)


class SeedSampler:
    def __init__(self, maximum, boundary, exclude_boundary, targets=None, require_source_address=False):
        self.maximum = maximum
        self.boundary = boundary
        self.exclude_boundary = exclude_boundary
        self.require_source_address = require_source_address
        self.candidates = []
        self.targets = sorted(targets or [], key=lambda value: (
            int(value.get("priority", 99)), -int(value.get("deficit", 0)), str(value.get("id", ""))
        ))
        self.target_tree = STRtree([
            Point(float(target["longitude"]), float(target["latitude"])) for target in self.targets
        ]) if self.targets else None
        self.target_maximum = max(2, math.ceil(maximum / len(self.targets)) * 2) if self.targets else 0
        self.target_candidates = [[] for _ in self.targets]

    def inside(self, longitude, latitude):
        if self.exclude_boundary and self.exclude_boundary.contains(longitude, latitude):
            return False
        return not self.boundary or self.boundary.contains(longitude, latitude)

    def way(self, way):
        tags = {tag.k: tag.v for tag in way.tags}
        building_class = tags.get("building", "").strip().casefold()
        if building_class not in RESIDENTIAL_BUILDINGS:
            return
        if any(tags.get(key, "").strip().casefold() not in {"", "no", "none"} for key in NON_RESIDENTIAL_POI_KEYS):
            return
        number = tags.get("addr:housenumber", "").strip()
        street = (tags.get("addr:street") or tags.get("addr:place") or "").strip()
        if self.require_source_address:
            if not number or not street:
                return
        elif number and street:
            return
        locations = [node.location for node in way.nodes]
        if len(locations) < 4 or not all(location.valid() for location in locations):
            return
        ring = [[location.lon, location.lat] for location in locations]
        if ring[0] != ring[-1]:
            return
        polygon = Polygon(ring)
        if not polygon.is_valid or polygon.is_empty or polygon.area <= 0:
            return
        point = polygon.representative_point()
        longitude = point.x
        latitude = point.y
        if not self.inside(longitude, latitude):
            return
        identifier = f"way/{way.id}"
        tile = f"{math.floor(longitude * 20)}:{math.floor(latitude * 20)}"
        priority = rank(f"{tile}:{identifier}")
        record = {
            "id": identifier,
            "building_id": identifier,
            "building_class": building_class,
            "longitude": longitude,
            "latitude": latitude,
            "ring": ring
        }
        if self.require_source_address:
            record["number"] = number
            record["street"] = street
        candidate = (-priority, identifier, record)
        if self.target_tree is not None:
            target_index = int(self.target_tree.nearest(Point(longitude, latitude)))
            target = self.targets[target_index]
            record["scheduling_hint"] = {
                "id": target.get("id"),
                "kind": target.get("kind"),
                "priority": target.get("priority")
            }
            candidates = self.target_candidates[target_index]
            if len(candidates) < self.target_maximum:
                heapq.heappush(candidates, candidate)
            elif priority < -candidates[0][0]:
                heapq.heapreplace(candidates, candidate)
            return
        if len(self.candidates) < self.maximum:
            heapq.heappush(self.candidates, candidate)
        elif priority < -self.candidates[0][0]:
            heapq.heapreplace(self.candidates, candidate)

    def selected(self):
        if not self.targets:
            return [record for _, _, record in sorted(
                (-priority, identifier, record) for priority, identifier, record in self.candidates
            )]
        selected = []
        priorities = sorted({int(target.get("priority", 99)) for target in self.targets})
        for target_priority in priorities:
            indexes = [index for index, target in enumerate(self.targets)
                       if int(target.get("priority", 99)) == target_priority]
            ordered = {
                index: [record for _, _, record in sorted(
                    (-priority, identifier, record)
                    for priority, identifier, record in self.target_candidates[index]
                )] for index in indexes
            }
            round_index = 0
            while len(selected) < self.maximum:
                added = False
                for index in indexes:
                    values = ordered[index]
                    if round_index < len(values):
                        selected.append(values[round_index])
                        added = True
                        if len(selected) >= self.maximum:
                            break
                if not added:
                    break
                round_index += 1
            if len(selected) >= self.maximum:
                break
        return selected


def targets_from_json(path):
    if not path:
        return []
    document = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    if not isinstance(document, list):
        raise ValueError("coverage targets must be a JSON array")
    return [target for target in document if (
        isinstance(target, dict)
        and math.isfinite(float(target.get("longitude", math.nan)))
        and math.isfinite(float(target.get("latitude", math.nan)))
    )]


def main():
    if osmium is None:
        raise RuntimeError("pyosmium is required to read OpenStreetMap PBF files")
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--boundary")
    parser.add_argument("--exclude-boundary", action="append", default=[])
    parser.add_argument("--coverage-targets")
    parser.add_argument("--max-records", required=True, type=int)
    parser.add_argument("--require-source-address", action="store_true")
    args = parser.parse_args()

    exclude_geometries = [boundary_from_geojson(path).geometry for path in args.exclude_boundary]
    exclude_boundary = CompiledBoundary(unary_union(exclude_geometries)) if exclude_geometries else None
    sampler = SeedSampler(
        args.max_records,
        boundary_from_geojson(args.boundary),
        exclude_boundary,
        targets_from_json(args.coverage_targets),
        args.require_source_address
    )
    location_index = None
    location_storage = "flex_mem"
    if pathlib.Path(args.input).stat().st_size >= 1_000_000_000:
        location_index = pathlib.Path(args.output).with_suffix(pathlib.Path(args.output).suffix + ".locations.idx")
        location_index.unlink(missing_ok=True)
        location_storage = f"sparse_file_array,{location_index}"
    try:
        processor = osmium.FileProcessor(args.input).with_locations(location_storage).with_filter(KeyFilter("building"))
        try:
            for entity in processor:
                if entity.is_way():
                    sampler.way(entity)
        finally:
            del processor
    finally:
        if location_index:
            location_index.unlink(missing_ok=True)

    with pathlib.Path(args.output).open("w", encoding="utf-8", newline="\n") as output:
        for record in sampler.selected():
            output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
