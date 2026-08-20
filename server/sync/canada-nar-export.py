import argparse
import csv
import hashlib
import heapq
import io
import json
import os
import pathlib
import re
import struct
import urllib.request
import zlib
import zipfile
from collections import defaultdict


POSTCODE_PATTERN = re.compile(r"^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z][0-9][ABCEGHJ-NPRSTV-Z][0-9]$")
PROVINCES = {
    "10": ("Newfoundland and Labrador", "NL"),
    "11": ("Prince Edward Island", "PE"),
    "12": ("Nova Scotia", "NS"),
    "13": ("New Brunswick", "NB"),
    "24": ("Quebec", "QC"),
    "35": ("Ontario", "ON"),
    "46": ("Manitoba", "MB"),
    "47": ("Saskatchewan", "SK"),
    "48": ("Alberta", "AB"),
    "59": ("British Columbia", "BC"),
    "60": ("Yukon", "YT"),
    "61": ("Northwest Territories", "NT"),
    "62": ("Nunavut", "NU"),
}


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def stable_digest(value):
    return hashlib.sha256(value.encode("utf-8")).digest()


def atomic_json(path, value):
    target = pathlib.Path(path)
    temporary = target.with_name(f"{target.name}.tmp")
    with open(temporary, "w", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, target)


class RemoteMember(io.RawIOBase):
    def __init__(self, response, compressed_size, uncompressed_size, expected_crc):
        self.response = response
        self.remaining = compressed_size
        self.expected_size = uncompressed_size
        self.expected_crc = expected_crc
        self.decompressor = zlib.decompressobj(-15)
        self.buffer = bytearray()
        self.output_size = 0
        self.crc = 0
        self.finished = False

    def readable(self):
        return True

    def _fill(self):
        while not self.buffer and not self.finished:
            chunk = self.response.read(min(1024 * 1024, self.remaining)) if self.remaining else b""
            self.remaining -= len(chunk)
            if chunk:
                decoded = self.decompressor.decompress(chunk)
            else:
                decoded = self.decompressor.flush()
                self.finished = True
            if decoded:
                self.output_size += len(decoded)
                self.crc = zlib.crc32(decoded, self.crc)
                self.buffer.extend(decoded)
            if self.finished:
                if self.remaining or not self.decompressor.eof:
                    raise OSError("Incomplete ZIP member")
                if self.output_size != self.expected_size or self.crc != self.expected_crc:
                    raise OSError("ZIP member integrity check failed")

    def readinto(self, target):
        self._fill()
        if not self.buffer:
            return 0
        count = min(len(target), len(self.buffer))
        target[:count] = self.buffer[:count]
        del self.buffer[:count]
        return count

    def close(self):
        self.response.close()
        super().close()


class RemoteZipSource:
    def __init__(self, url, expected_size=None, maximum_size=2 * 1024**3, opener=urllib.request.urlopen):
        self.url = url
        self.opener = opener
        with self._request(0, 0) as response:
            headers = response.headers
            content_range = headers.get("Content-Range", "")
            self.size = int(content_range.rsplit("/", 1)[-1]) if "/" in content_range else int(headers["Content-Length"])
        if expected_size and self.size != expected_size:
            raise ValueError(f"NAR archive size changed: {self.size} != {expected_size}")
        if self.size > maximum_size:
            raise ValueError(f"NAR archive exceeds maximum size: {self.size}")
        self.entries = self._entries()

    def _request(self, start, end):
        request = urllib.request.Request(self.url, headers={
            "Accept-Encoding": "identity",
            "Range": f"bytes={start}-{end}",
            "User-Agent": "address-sync/1.0",
        })
        response = self.opener(request, timeout=90)
        if getattr(response, "status", 206) != 206:
            response.close()
            raise OSError("NAR server did not honor the byte range")
        return response

    def _range(self, start, end):
        with self._request(start, end) as response:
            value = response.read()
        if len(value) != end - start + 1:
            raise OSError("Incomplete NAR byte range")
        return value

    def _entries(self):
        tail_size = min(self.size, 65557)
        tail = self._range(self.size - tail_size, self.size - 1)
        position = tail.rfind(b"PK\x05\x06")
        if position < 0:
            raise ValueError("NAR ZIP end record not found")
        _, disk, directory_disk, disk_entries, total_entries, directory_size, directory_offset, _ = struct.unpack(
            "<4s4H2LH", tail[position:position + 22]
        )
        if disk or directory_disk or disk_entries != total_entries:
            raise ValueError("Multi-disk ZIP archives are unsupported")
        directory = self._range(directory_offset, directory_offset + directory_size - 1)
        entries = {}
        offset = 0
        for _ in range(total_entries):
            values = struct.unpack_from("<4s6H3L5H2L", directory, offset)
            if values[0] != b"PK\x01\x02":
                raise ValueError("Invalid NAR ZIP central directory")
            filename_length, extra_length, comment_length = values[10:13]
            filename = directory[offset + 46:offset + 46 + filename_length].decode("utf-8")
            entries[filename] = {
                "method": values[4], "crc": values[7], "compressed": values[8],
                "uncompressed": values[9], "offset": values[-1]
            }
            offset += 46 + filename_length + extra_length + comment_length
        return entries

    def names(self):
        return list(self.entries)

    def fingerprint(self):
        lines = [f"{name}\t{entry['crc']:08x}\t{entry['compressed']}\t{entry['uncompressed']}"
                 for name, entry in sorted(self.entries.items()) if name.endswith(".csv")]
        return hashlib.sha256((str(self.size) + "\n" + "\n".join(lines)).encode("utf-8")).hexdigest()

    def open_text(self, name):
        entry = self.entries[name]
        if entry["method"] != 8:
            raise ValueError(f"Unsupported ZIP compression method for {name}")
        local = self._range(entry["offset"], entry["offset"] + 29)
        values = struct.unpack("<4s5H3L2H", local)
        if values[0] != b"PK\x03\x04":
            raise ValueError(f"Invalid ZIP local header for {name}")
        data_offset = entry["offset"] + 30 + values[-2] + values[-1]
        response = self._request(data_offset, data_offset + entry["compressed"] - 1)
        raw = RemoteMember(response, entry["compressed"], entry["uncompressed"], entry["crc"])
        return io.TextIOWrapper(io.BufferedReader(raw, 1024 * 1024), encoding="utf-8-sig", newline="")


class LocalZipSource:
    def __init__(self, path):
        self.archive = zipfile.ZipFile(path)
        self.entries = {entry.filename: entry for entry in self.archive.infolist()}

    def names(self):
        return list(self.entries)

    def fingerprint(self):
        lines = [f"{name}\t{entry.CRC:08x}\t{entry.compress_size}\t{entry.file_size}"
                 for name, entry in sorted(self.entries.items()) if name.endswith(".csv")]
        return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()

    def open_text(self, name):
        return io.TextIOWrapper(self.archive.open(name), encoding="utf-8-sig", newline="")


def province_members(source, kind, province):
    prefix = "Address" if kind == "Addresses" else "Location"
    pattern = re.compile(rf"^{kind}/{prefix}_{province}(?:_part_([0-9]+))?\.csv$")
    matches = []
    for name in source.names():
        match = pattern.match(name)
        if match:
            matches.append((int(match.group(1) or 0), name))
    return [name for _, name in sorted(matches)]


def address_candidate(row):
    if clean(row.get("BU_USE")) not in {"1", "2"}:
        return None
    identifier = clean(row.get("ADDR_GUID"))
    location_id = clean(row.get("LOC_GUID"))
    number = clean(row.get("CIVIC_NO")) + clean(row.get("CIVIC_NO_SUFFIX"))
    street = " ".join(filter(None, [clean(row.get("OFFICIAL_STREET_NAME")),
                                      clean(row.get("OFFICIAL_STREET_TYPE")),
                                      clean(row.get("OFFICIAL_STREET_DIR"))]))
    locality = clean(row.get("MAIL_MUN_NAME"))
    postcode = re.sub(r"\s+", "", clean(row.get("MAIL_POSTAL_CODE"))).upper()
    province_code = clean(row.get("PROV_CODE"))
    province = PROVINCES.get(province_code)
    if not identifier or not location_id or not number or not street or not locality or not province:
        return None
    if not POSTCODE_PATTERN.fullmatch(postcode):
        return None
    district = clean(row.get("CSD_ENG_NAME")) or clean(row.get("CSD_FRE_NAME"))
    return {
        "id": f"statcan-nar:{identifier}", "source_record_id": f"statcan-nar:{identifier}",
        "source_dataset": "Statistics Canada National Address Register",
        "country": "CA", "admin1": province[0], "admin1_code": province[1],
        "locality": locality.title(), "district": district, "postal_city": locality.title(),
        "address_levels": [province[0], locality.title(), district],
        "postcode": f"{postcode[:3]} {postcode[3:]}", "street": street, "number": number,
        "unit": clean(row.get("APT_NO_LABEL")), "property_type": "residential",
        "residential_building_id": f"statcan-nar-location:{location_id}",
        "residential_building_class": "residential" if clean(row.get("BU_USE")) == "1" else "partial-residential",
        "residential_evidence": f"BU_USE={clean(row.get('BU_USE'))}", "_location_id": location_id,
    }


def select_province_candidates(source, province, maximum):
    by_locality = defaultdict(list)
    sequence = 0
    for name in province_members(source, "Addresses", province):
        with source.open_text(name) as input_file:
            for row in csv.DictReader(input_file):
                candidate = address_candidate(row)
                if not candidate:
                    continue
                locality = candidate["locality"].casefold()
                digest = stable_digest(candidate["source_record_id"])
                heap = by_locality[locality]
                item = (-int.from_bytes(digest, "big"), sequence, candidate)
                sequence += 1
                locality_cap = max(4, min(250, maximum))
                if len(heap) < locality_cap:
                    heapq.heappush(heap, item)
                elif item > heap[0]:
                    heapq.heapreplace(heap, item)
    primary = []
    extra = []
    for locality, heap in by_locality.items():
        records = sorted(((-score, value) for score, _, value in heap), key=lambda item: item[0])
        primary.append((records[0][0], locality, records[0][1]))
        extra.extend((score, locality, value) for score, value in records[1:])
    selected = [value for _, _, value in sorted(primary)[:maximum]]
    if len(selected) < maximum:
        selected.extend(value for _, _, value in sorted(extra)[:maximum - len(selected)])
    return selected


def attach_coordinates(source, province, candidates):
    by_location = defaultdict(list)
    for candidate in candidates:
        by_location[candidate["_location_id"]].append(candidate)
    for name in province_members(source, "Locations", province):
        with source.open_text(name) as input_file:
            for row in csv.DictReader(input_file):
                matches = by_location.get(clean(row.get("LOC_GUID")))
                if not matches:
                    continue
                try:
                    latitude = float(clean(row.get("BG_LATITUDE")))
                    longitude = float(clean(row.get("BG_LONGITUDE")))
                except ValueError:
                    continue
                if not 41 <= latitude <= 84 or not -141 <= longitude <= -52:
                    continue
                for candidate in matches:
                    candidate["latitude"] = latitude
                    candidate["longitude"] = longitude
    return [candidate for candidate in candidates if "latitude" in candidate]


def select_balanced(values, maximum, per_locality):
    localities = defaultdict(list)
    for value in values:
        key = (value["admin1_code"], value["locality"].casefold())
        localities[key].append(value)
    queues = defaultdict(list)
    for key, records in localities.items():
        records.sort(key=lambda value: stable_digest(value["source_record_id"]))
        queues[key[0]].append(records[:max(1, per_locality)])
    selected = []
    provinces = sorted(queues)
    while provinces and len(selected) < maximum:
        remaining = []
        for province in provinces:
            province_queues = queues[province]
            records = province_queues.pop(0)
            selected.append(records.pop(0))
            if records:
                province_queues.append(records)
            if province_queues:
                remaining.append(province)
            if len(selected) >= maximum:
                break
        provinces = remaining
    for value in selected:
        value.pop("_location_id", None)
    return selected


def export(source, output_path, checkpoint_path, maximum, per_locality, provinces=None):
    output = pathlib.Path(output_path)
    checkpoint = pathlib.Path(checkpoint_path)
    state_directory = checkpoint.parent
    state_directory.mkdir(parents=True, exist_ok=True)
    fingerprint = source.fingerprint()
    try:
        state = json.loads(checkpoint.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    if state.get("fingerprint") != fingerprint or not isinstance(state.get("completed"), list):
        for path in state_directory.glob("*.jsonl"):
            path.unlink()
        state = {"fingerprint": fingerprint, "completed": []}
        atomic_json(checkpoint, state)
    configured = sorted(set(provinces or PROVINCES) & set(PROVINCES))
    available = [code for code in configured if province_members(source, "Addresses", code)
                 and province_members(source, "Locations", code)]
    province_cap = max(500, min(maximum, (maximum * 3 + max(1, len(available)) - 1) // max(1, len(available))))
    for province in available:
        province_file = state_directory / f"{province}.jsonl"
        if province in state["completed"] and province_file.exists():
            continue
        candidates = attach_coordinates(source, province, select_province_candidates(source, province, province_cap))
        temporary = province_file.with_suffix(".tmp")
        with open(temporary, "w", encoding="utf-8", newline="\n") as destination:
            for value in candidates:
                destination.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, province_file)
        state["completed"] = sorted(set(state["completed"]) | {province})
        atomic_json(checkpoint, state)
    values = []
    for province in state["completed"]:
        with open(state_directory / f"{province}.jsonl", encoding="utf-8") as input_file:
            values.extend(json.loads(line) for line in input_file if line.strip())
    selected = select_balanced(values, maximum, per_locality)
    temporary = output.with_name(f"{output.name}.tmp")
    output.parent.mkdir(parents=True, exist_ok=True)
    with open(temporary, "w", encoding="utf-8", newline="\n") as destination:
        for value in selected:
            destination.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        destination.flush()
        os.fsync(destination.fileno())
    os.replace(temporary, output)
    checkpoint.unlink(missing_ok=True)
    for path in state_directory.glob("*.jsonl"):
        path.unlink()
    try:
        state_directory.rmdir()
    except OSError:
        pass
    return {"accepted": len(selected), "provinces": len(state["completed"]), "fingerprint": fingerprint}


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--archive-url")
    source.add_argument("--archive-file")
    parser.add_argument("--expected-size", type=int)
    parser.add_argument("--maximum-archive-size", type=int, default=2 * 1024**3)
    parser.add_argument("--output", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--max-records", required=True, type=int)
    parser.add_argument("--per-locality", type=int, default=350)
    parser.add_argument("--province-code", action="append")
    args = parser.parse_args()
    archive = LocalZipSource(args.archive_file) if args.archive_file else RemoteZipSource(
        args.archive_url, args.expected_size, args.maximum_archive_size
    )
    print(json.dumps(export(archive, args.output, args.checkpoint, args.max_records,
                            args.per_locality, args.province_code), separators=(",", ":")))


if __name__ == "__main__":
    main()
