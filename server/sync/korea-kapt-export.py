import argparse
import hashlib
import http.cookiejar
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from datetime import datetime, timezone

from pyproj import Transformer


BASE_URL = "https://www.k-apt.go.kr"
POSTCODE_PATTERN = re.compile(r"\d{5}")
COMPOUND_CITY_PREFIXES = (
    "수원", "성남", "안양", "안산", "고양", "용인", "부천", "화성",
    "청주", "천안", "전주", "포항", "창원",
)
CSRF_PATTERNS = (
    re.compile(r'name="_csrf"[^>]*content="([^"]+)"'),
    re.compile(r'name="_csrf"[^>]*value="([^"]+)"'),
    re.compile(r"_csrf[^\w]+([A-Za-z0-9_-]{20,})"),
)


class GeocodeUnavailable(RuntimeError):
    pass


class BridgeUnavailable(RuntimeError):
    pass


MAX_CONSECUTIVE_BRIDGE_FAILURES = 12


class PostcodeBatch(list):
    def __init__(self, values, source_complete=True, checkpoint_token=None, resolved_count=0):
        super().__init__(values)
        self.source_complete = source_complete
        self.checkpoint_token = checkpoint_token
        self.resolved_count = resolved_count


@contextmanager
def exclusive_cache_lock(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError("Postcode cache is already in use") from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def number(value):
    source = clean(value)
    if not source.isdigit():
        return ""
    return str(int(source))


def lot_number(row):
    main = number(row.get("bun1"))
    secondary = number(row.get("bun2"))
    if not main or main == "0":
        return ""
    return f"{main}-{secondary}" if secondary and secondary != "0" else main


def normalize_hierarchy(values):
    normalized = []
    for value in values:
        split = False
        for city in COMPOUND_CITY_PREFIXES:
            district = value.removeprefix(city)
            if district != value and district.endswith("구") and district != "구":
                normalized.extend((f"{city}시", district))
                split = True
                break
        if not split:
            normalized.append(value)
    return normalized


def csrf_token(html):
    for pattern in CSRF_PATTERNS:
        match = pattern.search(html)
        if match:
            return match.group(1)
    raise RuntimeError("K-apt CSRF token is missing")


class KaptClient:
    def __init__(self):
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        request = urllib.request.Request(
            f"{BASE_URL}/web/main/index.do",
            headers={"User-Agent": "address-sync/1.0", "Accept": "text/html"},
        )
        with self.opener.open(request, timeout=30) as response:
            self.csrf = csrf_token(response.read().decode("utf-8", "ignore"))

    def post(self, path, values):
        body = urllib.parse.urlencode({**values, "_csrf": self.csrf}).encode()
        request = urllib.request.Request(
            f"{BASE_URL}{path}",
            data=body,
            headers={
                "User-Agent": "address-sync/1.0",
                "Accept": "application/json",
                "X-CSRF-TOKEN": self.csrf,
            },
        )
        for attempt in range(4):
            try:
                with self.opener.open(request, timeout=60) as response:
                    payload = json.load(response)
                values = payload.get("resultList")
                if not isinstance(values, list):
                    raise RuntimeError("K-apt response has no result list")
                return values
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                if attempt == 3:
                    raise RuntimeError("K-apt request failed") from None
                time.sleep(2 ** attempt)
        return []

    def apartments(self):
        provinces = self.post("/cmmn/bjd/getBjdList.do", {"bjdCode": "", "bjdGbn": "SIDO"})
        for province in provinces:
            code = clean(province.get("code"))
            if not re.fullmatch(r"\d{2}", code):
                continue
            for row in self.post("/kaptinfo/getKaptList.do", {
                "bjdCode": code,
                "searchDate": "",
                "kaptDuty": "ALL",
                "kaptName": "",
            }):
                yield row
            time.sleep(0.2)


def candidate(row, transformer):
    kapt_code = clean(row.get("kaptCode"))
    building_name = clean(row.get("kaptName"))
    source_hierarchy = clean(row.get("bjdName")).split()
    house_number = lot_number(row)
    source_address = clean(row.get("addr"))
    if not kapt_code or not building_name or len(source_hierarchy) < 3 or not house_number:
        return None
    if not source_address.startswith(" ".join(source_hierarchy)) or house_number not in source_address.split():
        return None
    hierarchy = normalize_hierarchy(source_hierarchy)
    try:
        longitude, latitude = transformer.transform(float(row["x"]), float(row["y"]))
    except (KeyError, TypeError, ValueError):
        return None
    if not 124 <= longitude <= 132 or not 33 <= latitude <= 39:
        return None
    admin1 = hierarchy[0]
    district = hierarchy[-1]
    locality = " ".join(hierarchy[1:-1])
    identity = f"{kapt_code}\x1f{source_address}\x1f{building_name}"
    return {
        "id": f"kapt:{kapt_code}",
        "source_record_id": f"kapt:{kapt_code}",
        "source_dataset": "K-apt official apartment complexes",
        "country": "KR",
        "admin1": admin1,
        "locality": locality,
        "district": district,
        "postal_city": locality,
        "address_levels": hierarchy,
        "street": district,
        "number": house_number,
        "building_name": building_name,
        "longitude": round(longitude, 8),
        "latitude": round(latitude, 8),
        "property_type": "apartment",
        "residential_building_id": f"kapt:{kapt_code}",
        "residential_building_class": "apartments",
        "source_rank": hashlib.sha256(identity.encode("utf-8")).hexdigest(),
    }


def balanced(values):
    groups = defaultdict(list)
    for value in values:
        groups[(value["admin1"], value["locality"], value["district"])].append(value)
    queues = [deque(sorted(group, key=lambda value: value["source_rank"])) for _, group in sorted(groups.items())]
    while queues:
        remaining = []
        for queue in queues:
            if queue:
                yield queue.popleft()
            if queue:
                remaining.append(queue)
        queues = remaining


def candidate_fingerprint(value):
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def collect_candidates(rows, transformer):
    candidates = {}
    for row in rows:
        value = candidate(row, transformer)
        if value:
            candidates[value["source_record_id"]] = value
    return [candidates[key] for key in sorted(candidates)]


def load_catalog(path):
    candidates = {}
    with open(path, encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
                record_id = clean(value["source_record_id"])
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise RuntimeError(f"Invalid K-apt catalog record at line {line_number}") from error
            if not record_id or not isinstance(value, dict):
                raise RuntimeError(f"Invalid K-apt catalog record at line {line_number}")
            candidates[record_id] = value
    return [candidates[key] for key in sorted(candidates)]


def write_json_atomic(path, value):
    absolute = os.path.abspath(path)
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    temporary = f"{absolute}.{os.getpid()}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as output:
            json.dump(value, output, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            output.write("\n")
        os.replace(temporary, absolute)
    finally:
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass


def write_catalog(path, values):
    absolute = os.path.abspath(path)
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    temporary = f"{absolute}.{os.getpid()}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as output:
            for value in sorted(values, key=lambda item: item["source_record_id"]):
                output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n")
        os.replace(temporary, absolute)
    finally:
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass


def catalog_fingerprint(values):
    digest = hashlib.sha256()
    for value in sorted(values, key=lambda item: item["source_record_id"]):
        digest.update(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def load_postcode_cache(path):
    cached = {}
    if not path or not os.path.exists(path):
        return cached
    with open(path, encoding="utf-8") as source:
        for line in source:
            try:
                value = json.loads(line)
                record_id = value["id"]
                requested_on = value.get("requested_on")
                cached[record_id] = {
                    "postcode": value.get("postcode"),
                    "requested_on": requested_on,
                    "result": value.get("result"),
                    "candidate_fingerprint": value.get("candidate_fingerprint"),
                }
            except (KeyError, TypeError, ValueError):
                continue
    return cached


def place_key(value):
    key = re.sub(r"[^0-9A-Za-z\uac00-\ud7a3]", "", clean(value)).casefold()
    return re.sub(r"(?:특별자치시|특별자치도|특별시|광역시|자치시|자치도|도|시)$", "", key)


def geoapify_matches_hierarchy(result, hierarchy):
    if clean(result.get("country_code")).lower() != "kr":
        return False
    top_levels = [place_key(result.get(field)) for field in ("state", "city")]
    expected = place_key(hierarchy[0])
    return bool(expected) and any(expected == value for value in top_levels if value)


def reverse_postcode(value, bridge_url):
    body = json.dumps({
        "latitude": value["latitude"],
        "longitude": value["longitude"],
    }, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        bridge_url,
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
            result = (payload.get("results") or [{}])[0]
            postcode = clean(result.get("postcode"))
            hierarchy = value["address_levels"]
            return postcode if POSTCODE_PATTERN.fullmatch(postcode) and geoapify_matches_hierarchy(result, hierarchy) else None
        except urllib.error.HTTPError as error:
            try:
                payload = json.load(error)
            except (json.JSONDecodeError, UnicodeDecodeError):
                payload = {}
            if payload.get("code") == "SOURCE_CREDENTIAL_UNAVAILABLE":
                raise GeocodeUnavailable("No Geoapify credential is currently available") from None
            raise RuntimeError(f"Geoapify bridge stopped with HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt == 2:
                raise BridgeUnavailable("Geoapify bridge is temporarily unavailable") from None
            time.sleep(0.25 * (2 ** attempt))


def postcode_checkpoint_token(values, cached):
    state = []
    for value in values:
        entry = cached.get(value["source_record_id"]) or {}
        state.append((value["source_record_id"], entry.get("result"), entry.get("postcode"),
                      entry.get("candidate_fingerprint")))
    return hashlib.sha256(json.dumps(
        sorted(set(state)), ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")).hexdigest()


def add_postcodes(values, cache_path, minimum_interval, concurrency=3):
    bridge_url = clean(os.environ.get("ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL"))
    if not bridge_url:
        raise RuntimeError("ADDRESS_SYNC_GEOAPIFY_BRIDGE_URL is required for the Korea K-apt export")
    today = datetime.now(timezone.utc).date().isoformat()
    values = list(values)
    os.makedirs(os.path.dirname(os.path.abspath(cache_path)), exist_ok=True)
    with exclusive_cache_lock(f"{cache_path}.lock"):
        cached = load_postcode_cache(cache_path)
        with open(cache_path, "a", encoding="utf-8", newline="\n") as cache_output:
            pending = []
            scheduled = set()
            for value in values:
                record_id = value["source_record_id"]
                cached_entry = cached.get(record_id) or {}
                fingerprint = candidate_fingerprint(value)
                validated_postcode = (POSTCODE_PATTERN.fullmatch(clean(cached_entry.get("postcode")))
                                      and cached_entry.get("candidate_fingerprint") == fingerprint)
                definitive_negative = (cached_entry.get("result") == "not_found"
                                       and cached_entry.get("candidate_fingerprint") == fingerprint)
                legacy_daily_negative = (not cached_entry.get("candidate_fingerprint")
                                         and cached_entry.get("requested_on") == today)
                should_request = (record_id not in scheduled
                                  and not validated_postcode
                                  and not definitive_negative
                                  and not legacy_daily_negative)
                if should_request:
                    pending.append(value)
                    scheduled.add(record_id)
            unavailable = False
            fatal_error = None
            consecutive_bridge_failures = 0
            transient_failures = 0
            last_started = 0.0
            cursor = 0
            active = {}
            with ThreadPoolExecutor(max_workers=max(1, min(concurrency, 4))) as executor:
                while active or (cursor < len(pending) and not unavailable):
                    while cursor < len(pending) and len(active) < concurrency and not unavailable:
                        elapsed = time.monotonic() - last_started
                        if elapsed < minimum_interval:
                            time.sleep(minimum_interval - elapsed)
                        value = pending[cursor]
                        cursor += 1
                        active[executor.submit(reverse_postcode, value, bridge_url)] = value
                        last_started = time.monotonic()
                    completed, _ = wait(active, return_when=FIRST_COMPLETED)
                    for future in completed:
                        value = active.pop(future)
                        postcode = None
                        try:
                            postcode = future.result()
                            consecutive_bridge_failures = 0
                        except GeocodeUnavailable as error:
                            unavailable = True
                            fatal_error = fatal_error or error
                        except BridgeUnavailable as error:
                            transient_failures += 1
                            consecutive_bridge_failures += 1
                            if consecutive_bridge_failures >= MAX_CONSECUTIVE_BRIDGE_FAILURES:
                                unavailable = True
                                fatal_error = fatal_error or error
                        except RuntimeError as error:
                            unavailable = True
                            fatal_error = fatal_error or error
                        record_id = value["source_record_id"]
                        if future.exception() is not None:
                            continue
                        fingerprint = candidate_fingerprint(value)
                        result = "found" if POSTCODE_PATTERN.fullmatch(clean(postcode)) else "not_found"
                        cached[record_id] = {
                            "postcode": postcode,
                            "requested_on": today,
                            "result": result,
                            "candidate_fingerprint": fingerprint,
                        }
                        cache_output.write(json.dumps({
                            "id": record_id,
                            "postcode": postcode,
                            "requested_on": today,
                            "event": "result",
                            "result": result,
                            "candidate_fingerprint": fingerprint,
                        }, ensure_ascii=False, separators=(",", ":")) + "\n")
                        cache_output.flush()
            resolved = 0
            for value in {item["source_record_id"]: item for item in values}.values():
                entry = cached.get(value["source_record_id"]) or {}
                if ((POSTCODE_PATTERN.fullmatch(clean(entry.get("postcode")))
                     and entry.get("candidate_fingerprint") == candidate_fingerprint(value))
                        or (entry.get("result") == "not_found"
                            and entry.get("candidate_fingerprint") == candidate_fingerprint(value))):
                    resolved += 1
            if fatal_error and not isinstance(fatal_error, GeocodeUnavailable):
                raise fatal_error
            if fatal_error and not resolved:
                fatal_error.checkpoint_token = postcode_checkpoint_token(values, cached)
                fatal_error.resolved_count = resolved
                raise fatal_error
        output = []
        for value in values:
            record_id = value["source_record_id"]
            entry = cached.get(record_id) or {}
            postcode = entry.get("postcode")
            if (POSTCODE_PATTERN.fullmatch(clean(postcode))
                    and entry.get("candidate_fingerprint") == candidate_fingerprint(value)):
                output.append({**value, "postcode": postcode})
        source_complete = resolved == len({value["source_record_id"] for value in values})
        if transient_failures:
            source_complete = False
        checkpoint_token = None
        if not source_complete:
            checkpoint_token = postcode_checkpoint_token(values, cached)
        return PostcodeBatch(output, source_complete, checkpoint_token, resolved)


def select(values, maximum, per_locality):
    counts = defaultdict(int)
    selected = []
    for value in values:
        key = value["admin1"], value["locality"], value["district"]
        if counts[key] >= per_locality:
            continue
        counts[key] += 1
        selected.append(value)
        if len(selected) >= maximum:
            break
    return selected


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output")
    mode.add_argument("--catalog-output")
    parser.add_argument("--catalog-input")
    parser.add_argument("--state-output")
    parser.add_argument("--postcode-cache")
    parser.add_argument("--max-records", type=int)
    parser.add_argument("--per-locality", type=int)
    parser.add_argument("--minimum-interval", type=float, default=0.25)
    parser.add_argument("--geocode-concurrency", type=int, default=3)
    args = parser.parse_args()
    if (args.minimum_interval < 0 or not 1 <= args.geocode_concurrency <= 4):
        raise ValueError("Invalid export limits")
    if args.catalog_output and args.catalog_input:
        parser.error("--catalog-output cannot be combined with --catalog-input")
    if args.output and (not args.postcode_cache or not args.max_records or not args.per_locality):
        parser.error("full export requires --postcode-cache, --max-records, and --per-locality")
    if args.output and (args.max_records < 1 or args.per_locality < 1):
        raise ValueError("Invalid export limits")
    if args.catalog_input:
        candidates = load_catalog(args.catalog_input)
    else:
        transformer = Transformer.from_crs("EPSG:5174", "EPSG:4326", always_xy=True)
        candidates = collect_candidates(KaptClient().apartments(), transformer)
    if args.catalog_output:
        write_catalog(args.catalog_output, candidates)
        return
    ordered = balanced(candidates)
    try:
        batch = add_postcodes(ordered, args.postcode_cache, args.minimum_interval, args.geocode_concurrency)
    except GeocodeUnavailable as error:
        batch = PostcodeBatch([], False, error.checkpoint_token, error.resolved_count)
    selected = select(batch, args.max_records, args.per_locality)
    with open(args.output, "w", encoding="utf-8", newline="\n") as output:
        for value in selected:
            value.pop("source_rank", None)
            output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    if args.state_output:
        write_json_atomic(args.state_output, {
            "version": 1,
            "source_complete": batch.source_complete,
            "checkpoint_token": batch.checkpoint_token,
            "catalog_fingerprint": catalog_fingerprint(candidates),
            "candidate_count": len(candidates),
            "resolved_count": batch.resolved_count,
            "publishable_count": len(batch),
            "selected_count": len(selected),
        })


if __name__ == "__main__":
    main()
