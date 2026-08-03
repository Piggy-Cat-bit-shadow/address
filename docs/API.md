# Address API Reference

[English](API.md) · [简体中文](API.zh-CN.md) · [繁體中文](API.zh-TW.md)

The external API is served under `/api/v1`. Its data endpoints use `GET` and return JSON. Interactive parameter documentation is available at `/en/api/` and `/zh-CN/api/` on a running instance.

## Base URL

```text
https://YOUR_DOMAIN.example/api/v1
```

Local development defaults to `http://127.0.0.1:8787/api/v1`.

Except for `/api/v1/health`, external API requests use an administrator-created Bearer token:

```http
Authorization: Bearer YOUR_API_TOKEN
```

Tokens are created in `/admin/`. The server stores both an irreversible authentication hash and ciphertext protected by the server master key. An administrator can set scopes, rate limits, and expiry, then reveal, edit, or revoke a token in an authenticated session. The WebUI uses its own `/web-api/v1` session channel and never embeds this token. Authentication failures return `401`; per-token rate-limit exhaustion returns `429` with `Retry-After: 60`.

## External endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Lightweight API health check |
| `GET` | `/countries` | Country registry, synchronized counts, and strict residential coverage |
| `GET` | `/client-context` | Resolve the request IP or an explicit IP to a supported region |
| `GET` | `/locations/search` | Search region, city, and postcode options |
| `GET` | `/generate` | Generate a verified residential address and related test profile |
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
curl -fsS https://YOUR_DOMAIN.example/api/v1/countries
```

The response is `{ "data": [...] }`. Each country includes its code, localized name, supported filters, total synchronized count, verified residential count, residential availability, and `generationMode`. Public generation uses only the verified residential pool; total counts remain visible for migration and health reporting. Counts are `null` when no database is attached.

## Client context

Resolve the current request:

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/client-context
```

Resolve an explicit IPv4 or IPv6 address:

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/client-context?ip=8.8.8.8"
```

The response may contain `publicIp`, country, region, city, postcode, latitude, and longitude. `TRUST_PROXY=true` should be used only behind a controlled reverse proxy that overwrites forwarded IP headers.

## Location search

| Parameter | Default | Description |
|---|---|---|
| `country` | `US` | Supported ISO-style project country code |
| `field` | `city` | `region`, `city`, or `postcode` |
| `q` | empty | Search text |
| `region` | empty | Parent region text |
| `regionId` | empty | Stable parent region ID |
| `cityId` | empty | Stable parent city ID |
| `residential` | `false` (catalog compatibility) | Set `true` to list only verified residential coverage; `/generate` always uses residential records |
| `cursor` | empty | Pagination cursor returned by the previous request |
| `limit` | `100` | Requested page size |

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/locations/search?country=US&field=city&q=San"
```

The response contains `regions`, `cities`, `postcodes`, `matches`, and, when a catalog database is available, `total`, `nextCursor`, and `source`.

## Generate

| Parameter | Default | Description |
|---|---|---|
| `country` | `US` | Country code; ignored when IP mode resolves a country |
| `mode` | `residential` | Set `ip-region` for IP coordinate/city matching |
| `ip` | request IP | Explicit IP used with `mode=ip-region` |
| `residential` | `true` | Legacy compatibility flag; `true` and `false` are accepted, while public generation always enforces residential evidence |
| `region`, `city`, `postcode` | empty | Human-readable location filters |
| `regionId`, `cityId`, `postcodeId` | empty | Stable catalog IDs |
| `q` | empty | Free-text location hint |
| `strategy` | `random` | Select an eligible verified record with `random` or `instant`; it never synthesizes address fields |
| `seed` | generated UUID | Deterministic generation seed |
| `requestId` | generated UUID | Caller correlation ID |

Verified residential generation:

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=US"
```

China generation with a location filter:

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=CN&city=Nanjing"
```

IP-region generation:

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?mode=ip-region&ip=8.8.8.8"
```

The response envelope is `{ "data": { ... } }`. Generation data includes the request ID, mode, country, filters, exact `filterMatchLevel` or IP `ipMatchLevel`, sources tried, timing information, and a `result` bundle. Normal generation also returns `eligibleCount`, the number of publication-gated database records in the exact selection scope. Address variants and indoor fields are source-backed; missing fields remain empty. Profile, sandbox card, employment, finance, and internet fields remain synthetic test data. A filtered request is exact-or-empty, while IP mode requires a coordinate or city match.

Normal requests select from the complete eligible database scope, without a fixed candidate window or fixed sequence. Use `seed` when tests need reproducible eligible-record selection and synthetic profile fields. Without it, every request receives a new server-generated UUID. The seed does not create missing address components, and source synchronization can change the selected residential pool over time.

## Address translation

`POST /address-translation` returns the semantic components (building, street, city, district, admin area) of a generated pool address in a display locale; digit identifiers (house number, unit, postcode) are always copied verbatim.

| Parameter | Default | Description |
|---|---|---|
| `addressId` | required | `result.address.id` returned by `/generate` |
| `targetLocale` | required | `en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `es`, or `pt` |

The display chain is stored variant → on-demand translation → native original. A stored variant is served only when every semantic component already reads in the target script; otherwise the service applies local script conversion (OpenCC for Chinese targets, pinyin as the English last resort for Chinese sources) and the configured translation providers in order, validating each candidate for script and digit preservation. The response is always complete in a single language: when no step produces a valid result it reports `fallback` or `unavailable` and clients render the full native address — never a mixed one.

## WebUI map configuration

Map display is a WebUI concern and does not change `/generate` address evidence. The session-protected `/web-api/v1` channel returns only display flags and, when enabled, the dedicated AMap JS API key required by the browser. It never returns the AMap JS security code or any synchronization key.

Google and AMap each have independent China and overseas switches. Defaults are Google enabled and AMap disabled in both regions. China AMap markers use GCJ-02 coordinates; overseas AMap rendering requires the account's World Map permission. AMap service requests use the same-origin `/_AMapService` prefix, where the server adds the encrypted security code before forwarding to the fixed AMap upstream.

## Data health

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/data-health
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

## Sync management API

The synchronization service normally listens on `127.0.0.1:8791`. Mutation and job endpoints require `Authorization: Bearer SYNC_ADMIN_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Local sync service health on port `8791` |
| `POST` | `/api/v1/sync/jobs` | Start an `initial` or `manual` job |
| `GET` | `/api/v1/sync/jobs/latest` | Read the latest job |
| `GET` | `/api/v1/sync/jobs/{id}` | Read one job |

```bash
curl -fsS -X POST http://127.0.0.1:8791/api/v1/sync/jobs \
  -H "Authorization: Bearer $SYNC_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"manual","shards":["US"]}'
```

Accepted jobs return HTTP `202`, a job object, and a `Location` header. A concurrent job returns `409`. Invalid JSON, mode, or shard identifiers return `400`.

The main API hides `/sync-control/*` by default. Keep `SYNC_CONTROL_PUBLIC=false`; manage synchronization through the local port or an additional private access boundary.

## CORS and privacy

- Set `ALLOWED_ORIGIN` to the public HTTPS origin in production.
- Do not place API keys or `SYNC_ADMIN_TOKEN` in query strings, browser code, screenshots, or logs.
- Use a dedicated, domain-restricted AMap JS API key for browser rendering. The JS key is necessarily visible in browser requests; the paired security code and all WebService synchronization keys remain server-only.
