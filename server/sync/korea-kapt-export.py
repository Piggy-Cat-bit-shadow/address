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
MAX_DAILY_GEOCODE_REQUESTS = 2800
COMPOUND_CITY_PREFIXES = (
    "수원", "성남", "안양", "안산", "고양", "용인", "부천", "화성",
    "청주", "천안", "전주", "포항", "창원",
)
CSRF_PATTERNS = (
    re.compile(r'name="_csrf"[^>]*content="([^"]+)"'),
    re.compile(r'name="_csrf"[^>]*value="([^"]+)"'),
    re.compile(r"_csrf[^\w]+([A-Za-z0-9_-]{20,})"),
)


class GeocodeQuotaExhausted(RuntimeError):
    pass


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


def load_postcode_cache(path):
    cached = {}
    daily_requests = defaultdict(int)
    if not path or not os.path.exists(path):
        return cached, daily_requests
    with open(path, encoding="utf-8") as source:
        for line in source:
            try:
                value = json.loads(line)
                record_id = value["id"]
                requested_on = value.get("requested_on")
                event = value.get("event")
                if event != "result" and requested_on:
                    daily_requests[requested_on] += 1
                cached[record_id] = {
                    "postcode": value.get("postcode"),
                    "requested_on": requested_on,
                }
            except (KeyError, TypeError, ValueError):
                continue
    return cached, daily_requests


def place_key(value):
    key = re.sub(r"[^0-9A-Za-z\uac00-\ud7a3]", "", clean(value)).casefold()
    return re.sub(r"(?:특별자치시|특별자치도|특별시|광역시|자치시|자치도|도|시)$", "", key)


def geoapify_matches_hierarchy(result, hierarchy):
    if clean(result.get("country_code")).lower() != "kr":
        return False
    top_levels = [place_key(result.get(field)) for field in ("state", "city")]
    expected = place_key(hierarchy[0])
    return bool(expected) and any(expected == value for value in top_levels if value)


def reverse_postcode(value, api_key):
    query = urllib.parse.urlencode({
        "lat": value["latitude"],
        "lon": value["longitude"],
        "format": "json",
        "lang": "ko",
        "apiKey": api_key,
    })
    request = urllib.request.Request(
        f"https://api.geoapify.com/v1/geocode/reverse?{query}",
        headers={"Accept": "application/json", "User-Agent": "address-sync/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        result = (payload.get("results") or [{}])[0]
        postcode = clean(result.get("postcode"))
        hierarchy = value["address_levels"]
        return postcode if POSTCODE_PATTERN.fullmatch(postcode) and geoapify_matches_hierarchy(result, hierarchy) else None
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise GeocodeQuotaExhausted("Geoapify daily quota is exhausted") from None
        if error.code in {401, 403}:
            raise RuntimeError(f"Geoapify request stopped with HTTP {error.code}") from None
        return None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None


def add_postcodes(values, cache_path, daily_limit, minimum_interval, concurrency=3):
    api_key = clean(os.environ.get("GEOAPIFY_API_KEY"))
    if not api_key:
        raise RuntimeError("GEOAPIFY_API_KEY is required for the Korea K-apt export; without it no record can pass postcode verification")
    today = datetime.now(timezone.utc).date().isoformat()
    values = list(values)
    os.makedirs(os.path.dirname(os.path.abspath(cache_path)), exist_ok=True)
    with exclusive_cache_lock(f"{cache_path}.lock"):
        cached, daily_requests = load_postcode_cache(cache_path)
        with open(cache_path, "a", encoding="utf-8", newline="\n") as cache_output:
            pending = []
            scheduled = set()
            remaining = max(0, daily_limit - daily_requests[today])
            for value in values:
                record_id = value["source_record_id"]
                cached_entry = cached.get(record_id) or {}
                should_request = (record_id not in scheduled
                                  and not POSTCODE_PATTERN.fullmatch(clean(cached_entry.get("postcode")))
                                  and cached_entry.get("requested_on") != today)
                if should_request and api_key and len(pending) < remaining:
                    pending.append(value)
                    scheduled.add(record_id)
            quota_exhausted = False
            fatal_error = None
            last_started = 0.0
            cursor = 0
            active = {}
            with ThreadPoolExecutor(max_workers=max(1, min(concurrency, 4))) as executor:
                while active or (cursor < len(pending) and not quota_exhausted):
                    while cursor < len(pending) and len(active) < concurrency and not quota_exhausted:
                        elapsed = time.monotonic() - last_started
                        if elapsed < minimum_interval:
                            time.sleep(minimum_interval - elapsed)
                        value = pending[cursor]
                        cursor += 1
                        record_id = value["source_record_id"]
                        cache_output.write(json.dumps({
                            "id": record_id,
                            "requested_on": today,
                            "event": "reserved",
                        }, ensure_ascii=False, separators=(",", ":")) + "\n")
                        cache_output.flush()
                        os.fsync(cache_output.fileno())
                        cached[record_id] = {"postcode": None, "requested_on": today}
                        daily_requests[today] += 1
                        active[executor.submit(reverse_postcode, value, api_key)] = value
                        last_started = time.monotonic()
                    completed, _ = wait(active, return_when=FIRST_COMPLETED)
                    for future in completed:
                        value = active.pop(future)
                        postcode = None
                        try:
                            postcode = future.result()
                        except GeocodeQuotaExhausted:
                            quota_exhausted = True
                        except RuntimeError as error:
                            quota_exhausted = True
                            fatal_error = fatal_error or error
                        record_id = value["source_record_id"]
                        cached[record_id] = {"postcode": postcode, "requested_on": today}
                        cache_output.write(json.dumps({
                            "id": record_id,
                            "postcode": postcode,
                            "requested_on": today,
                            "event": "result",
                        }, ensure_ascii=False, separators=(",", ":")) + "\n")
                        cache_output.flush()
            if fatal_error:
                raise fatal_error
        for value in values:
            record_id = value["source_record_id"]
            postcode = (cached.get(record_id) or {}).get("postcode")
            if POSTCODE_PATTERN.fullmatch(clean(postcode)):
                yield {**value, "postcode": postcode}


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
    parser.add_argument("--output", required=True)
    parser.add_argument("--postcode-cache", required=True)
    parser.add_argument("--max-records", type=int, required=True)
    parser.add_argument("--per-locality", type=int, required=True)
    parser.add_argument("--daily-geocode-limit", type=int, default=2800)
    parser.add_argument("--minimum-interval", type=float, default=0.25)
    parser.add_argument("--geocode-concurrency", type=int, default=3)
    args = parser.parse_args()
    if (args.max_records < 1 or args.per_locality < 1 or args.minimum_interval < 0
            or not 0 <= args.daily_geocode_limit <= MAX_DAILY_GEOCODE_REQUESTS
            or not 1 <= args.geocode_concurrency <= 4):
        raise ValueError("Invalid export limits")
    transformer = Transformer.from_crs("EPSG:5174", "EPSG:4326", always_xy=True)
    candidates = []
    seen = set()
    for row in KaptClient().apartments():
        value = candidate(row, transformer)
        if not value or value["source_record_id"] in seen:
            continue
        seen.add(value["source_record_id"])
        candidates.append(value)
    ordered = balanced(candidates)
    selected = select(
        add_postcodes(ordered, args.postcode_cache, args.daily_geocode_limit,
                      args.minimum_interval, args.geocode_concurrency),
        args.max_records,
        args.per_locality,
    )
    with open(args.output, "w", encoding="utf-8", newline="\n") as output:
        for value in selected:
            value.pop("source_rank", None)
            output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
