# Address API Reference

[English](API.md) · [简体中文](API.zh-CN.md) · [繁體中文](API.zh-TW.md)

The external API is served under `/api/v1` and returns JSON. Interactive parameter documentation is available at `/en/api/` and `/zh-CN/api/` on a running instance.

## Base URL

```text
https://YOUR_DOMAIN.example/api/v1
```

Local development defaults to `http://127.0.0.1:8787/api/v1`.

Except for `/api/v1/health`, `/api/v1/ready`, and `/api/v1/openapi.json`, external API requests use an administrator-created Bearer token:

```http
Authorization: Bearer YOUR_API_TOKEN
```

Create tokens in `/admin/`, where scopes, rate limits, and expiry can also be managed. Authentication failures return `401`; per-token rate-limit exhaustion returns `429` with `Retry-After: 60`.

## Quick start

### curl

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=US" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

### Python

```python
import json
from urllib.request import Request, urlopen

request = Request(
    "https://YOUR_DOMAIN.example/api/v1/generate?country=US",
    headers={"Authorization": "Bearer YOUR_API_TOKEN"},
)
with urlopen(request) as response:
    print(json.load(response))
```

### JavaScript

```javascript
const response = await fetch(
  "https://YOUR_DOMAIN.example/api/v1/generate?country=US",
  { headers: { Authorization: "Bearer YOUR_API_TOKEN" } },
);
const payload = await response.json();
console.log(payload);
```

## External endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Lightweight API health check |
| `GET` | `/ready` | PostgreSQL readiness check |
| `GET` | `/openapi.json` | OpenAPI 3.1 contract |
| `GET` | `/countries` | Country registry, synchronized counts, and strict residential coverage |
| `GET` | `/availability` | Public generation availability for every configured country |
| `GET` | `/client-context` | Resolve the request IP or an explicit IP to a supported region |
| `GET` | `/locations/search` | Search region, city, and postcode options |
| `GET` | `/locations/hierarchy` | Navigate parent-child administrative and postcode options |
| `GET` | `/generate` | Generate a verified residential address and related test profile |
| `POST` | `/generate/batch` | Generate up to 50 addresses with structured filters and uniqueness control |
| `GET` | `/addresses/{id}` | Retrieve a currently published address by generated ID |
| `GET` | `/coverage` | Inspect the three country synchronization completion rules |
| `POST` | `/address-translation` | Translate a generated address into a supported display locale |
| `GET` | `/data-health` | Inspect synchronized pool coverage and readiness |

## Health

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/health
```

```json
{"status":"ok"}
```

## Countries

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/countries \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

The response is `{ "data": [...] }`. Each country includes its code, localized name, supported filters, total synchronized count, verified residential count, residential availability, and `generationMode`. Public generation uses only the verified residential pool; total counts remain visible for migration and health reporting. Counts are `null` when no database is attached.

## Availability

```bash
curl -fsS -H "Authorization: Bearer YOUR_API_TOKEN" \
  https://YOUR_DOMAIN.example/api/v1/availability
```

The response reports whether each configured country currently has publication-gated residential records available for generation.

## Client context

Resolve the current request:

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/client-context \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

Resolve an explicit IPv4 or IPv6 address:

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/client-context?ip=8.8.8.8" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

The response may contain `publicIp`, country, region, city, postcode, latitude, and longitude. `TRUST_PROXY=true` should be used only behind a controlled reverse proxy that overwrites forwarded IP headers.

## Location search

| Parameter | Default | Description |
|---|---|---|
| `country` | `US` | Supported ISO-style project country code |
| `field` | `city` | `region`, `city`, `district`, or `postcode` |
| `q` | empty | Search text |
| `region` | empty | Parent region text |
| `regionId` | empty | Stable parent region ID |
| `cityId` | empty | Stable parent city ID |
| `residential` | `false` (catalog compatibility) | Set `true` to list only verified residential coverage; `/generate` always uses residential records |
| `cursor` | empty | Pagination cursor returned by the previous request |
| `limit` | `100` | Requested page size from `20` through `200` |

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/locations/search?country=US&field=city&q=San" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

The response contains `regions`, `cities`, `postcodes`, `matches`, and, when a catalog database is available, `total`, `nextCursor`, and `source`.

## Generate

| Parameter | Default | Description |
|---|---|---|
| `country` | `US` | Country code; ignored when IP mode resolves a country |
| `mode` | `residential` | Set `ip-region` for IP coordinate/city matching |
| `ip` | request IP | Explicit IP used with `mode=ip-region` |
| `residential` | `true` | Legacy compatibility flag; `true` and `false` are accepted, while public generation always enforces residential evidence |
| `region`, `city`, `district`, `postcode` | empty | Human-readable location filters |
| `regionId`, `cityId`, `districtId`, `postcodeId` | empty | Stable catalog IDs |
| `q` | empty | Free-text location hint |
| `strategy` | `random` | Select an eligible verified record with `random` or `instant`; it never synthesizes address fields |
| `seed` | generated UUID | Deterministic generation seed |
| `requestId` | generated UUID | Caller correlation ID |

Verified residential generation:

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=US" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

China generation with a location filter:

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=CN&city=Nanjing" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

IP-region generation:

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?mode=ip-region&ip=8.8.8.8" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

The response envelope is `{ "data": { ... } }`. Generation data includes the request ID, mode, country, filters, exact `filterMatchLevel` or IP `ipMatchLevel`, sources tried, timing information, and a `result` bundle. Normal generation also returns `eligibleCount`, the number of publication-gated database records in the exact selection scope. Address variants and indoor fields are source-backed; missing fields remain empty. Profile, sandbox card, employment, finance, and internet fields remain synthetic test data. A filtered request is exact-or-empty, while IP mode requires a coordinate or city match.

Unfiltered country requests map the seed to a dense PostgreSQL generation rank so every eligible record has the same selection probability. Filtered requests use bounded circular index windows spanning the complete matching scope. Neither path uses a fixed subset or fixed sequence. Use `seed` when tests need reproducible eligible-record selection and synthetic profile fields. Without it, every request receives a new server-generated UUID. The seed does not create missing address components, and source synchronization can change the selected residential pool over time.

## Batch generation and structured queries

`POST /generate/batch` accepts `count` from 1 through 50, a required `filters` object, optional `options` (`unique`, `seed`, `strategy`, `requestId`), and up to 500 `excludeAddressIds`. It returns the requested records when enough unique eligible addresses exist and marks a partial response with `exhausted: true` otherwise.

`GET /locations/hierarchy` navigates catalog children with `country`, `parentType`, `parentId`, and `childType`. `GET /addresses/{id}` reloads a currently published synchronized address. `GET /coverage` returns total-count, complete administrative coverage, and per-node minimum rules separately for every enabled country.

## Address translation

`POST /address-translation` returns the semantic components (building, street, city, district, admin area) of a generated pool address in a display locale; digit identifiers (house number, unit, postcode) are always copied verbatim.

| Parameter | Default | Description |
|---|---|---|
| `addressId` | required | `result.address.id` returned by `/generate` |
| `targetLocale` | required | `en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `es`, or `pt` |

The response uses one language consistently and preserves numeric identifiers. If no valid translated variant is available, it reports `fallback` or `unavailable` so the client can display the complete native address.

## Data health

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/data-health \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

This endpoint reports configured countries, invalid configuration entries, hot-pool coverage, low-water slots, and readiness. It is intended for monitoring and deployment checks.

## Errors

Errors use this envelope:

```json
{
  "error": {
    "code": "INVALID_COUNTRY",
    "message": "Unknown country code: ZZ"
  }
}
```

Common codes include `INVALID_COUNTRY`, `INVALID_FIELD`, `INVALID_LOCATION`, `INVALID_RESIDENTIAL`, `IP_LOCATION_UNAVAILABLE`, `NO_POOL_COVERAGE`, and IP lookup validation errors. Callers should branch on `error.code`, not translated UI text.

## CORS and privacy

- Set `ALLOWED_ORIGINS` to the comma-separated public HTTPS origins in production.
- Do not place API keys or `SYNC_ADMIN_TOKEN` in query strings, browser code, screenshots, or logs.
