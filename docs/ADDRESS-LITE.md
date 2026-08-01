# Address Lite / Ultra Lite

This profile converts the upstream project into a build-time verified, runtime-static address site.

## Runtime architecture

```text
GitHub Actions
  -> upstream source discovery
  -> Overture / Geofabrik materialization
  -> upstream strict residential validation
  -> max 3 addresses per Region + City + Postcode slot
  -> static JSON shards
  -> Astro static build
  -> atomic upload to VPS

VPS
  -> Nginx only
  -> /var/www/address/current -> releases/<commit>
```

The VPS does **not** run Node, SQLite, Python, DuckDB, the sync controller, or Supervisor for Address Lite.

## Quality invariants

The Lite profile intentionally keeps the upstream residential gate intact:

- `ADDRESS_SYNC_OVERTURE_BUILDINGS=true`
- `ADDRESS_SYNC_REQUIRE_RESIDENTIAL=true`
- the current `strict-residential-v15` importer still requires `property_type` to be `residential` or `apartment`
- the importer still requires independent `residentialSourceRecordId` evidence
- upstream address-quality validation still requires real street / house number and the country's required geographic fields
- the static verifier fails if a published address is not residential/apartment, lacks street/house number/coordinates, is duplicated in a target, or if any postcode slot exceeds 3 addresses

No retry path lowers those requirements. If a target remains under-filled after its final retry tier, the build publishes only the addresses that actually passed verification and records the shortage in metrics.

## Target whitelist

`config/lite-targets.json` is the only Lite target manifest. Mainland China is intentionally absent.

The manifest currently contains:

- 26 countries / regions
- 95 requested low-tax / tax-free areas and major-city targets
- 63 GitHub Actions matrix groups (48 precise Overture targets + 15 shared Geofabrik source groups)

The UI presents two separate categories:

1. Low-tax / tax-free areas
2. Major cities

Each target contains a conservative geographic bounding box. Overture targets use that box at GeoParquet/STAC selection time. Geofabrik targets use one or more boxes while scanning the downloaded PBF so non-target addresses are discarded before the candidate pool is built.

## Lite candidate profiles

The upstream project is designed for large public address pools. Lite uses a separate opt-in mode, enabled only by `ADDRESS_SYNC_LITE=true`.

| Control | Upstream behavior | Lite behavior |
|---|---|---|
| Country target | SQLite country policy, typically thousands/tens of thousands | supplied by the target retry tier |
| ETL candidate pool | `min(300000, max(targetCount + 1000, targetCount * 3))` | bounded small pool: `max(minCandidates, targetCount * multiplier)`, capped by `maxCandidates` |
| Per-locality materialization | may be enlarged by L1-L4 public-pool limits | explicit Lite `perLocality` |
| Prepare concurrency | runtime policy, default 10 | 1 per runner |
| CPU process concurrency | runtime policy, default 3 | 1 per runner |
| Overture Buildings | enabled | enabled |
| Residential gate | enabled/current strict importer | unchanged |
| Overture DuckDB threads | 4 | unchanged |
| Overture DuckDB memory limit | 2 GB | unchanged |
| Overture source sample | 25% | adaptive: 25% -> 50% -> 100% only for an under-filled target |
| Translation | optional | disabled completely |
| Raw retention | normally disabled | disabled; temporary source files are never deployed |

Default Lite environment values in the workflow:

```text
ADDRESS_SYNC_LITE=true
ADDRESS_SYNC_LITE_CANDIDATE_MULTIPLIER=2
ADDRESS_SYNC_LITE_MIN_CANDIDATES=32
ADDRESS_SYNC_LITE_MAX_CANDIDATES=15000
ADDRESS_SYNC_PREPARE_CONCURRENCY=1
ADDRESS_SYNC_CPU_CONCURRENCY=1
ADDRESS_SYNC_TRANSLATION_ENABLED=false
ADDRESS_SYNC_TRANSLATION_COUNTRIES=
TRANSLATION_BACKFILL_ENABLED=false
GOOGLE_TRANSLATION_ENABLED=false
ADDRESS_SYNC_RETAIN_RAW=false
```

### Upstream public-pool policy values bypassed by Lite mode

These are the current upstream defaults from `server/sync/address-policy.mjs`. They remain untouched for normal upstream runs. When `ADDRESS_SYNC_LITE=true`, the temporary build overrides them per target instead of persisting modified country policies.

| Country | Upstream target | L1 | L2 | L3 | L4 |
|---|---:|---:|---:|---:|---:|
| US | 50,000 | 2,000 | 300 | 80 | 0 |
| CA | 35,000 | 2,500 | 350 | 80 | 0 |
| MX | 30,000 | 2,000 | 300 | 70 | 0 |
| GB | 35,000 | 3,000 | 350 | 80 | 0 |
| DE | 40,000 | 2,500 | 350 | 80 | 0 |
| FR | 40,000 | 3,500 | 350 | 80 | 0 |
| IT | 35,000 | 2,500 | 350 | 80 | 0 |
| ES | 35,000 | 2,500 | 350 | 80 | 0 |
| NL | 30,000 | 3,000 | 400 | 80 | 0 |
| JP | 40,000 | 1,500 | 200 | 50 | 0 |
| HK | 12,000 | 2,000 | 300 | 80 | 0 |
| TW | 25,000 | 2,000 | 300 | 70 | 0 |
| KR | 20,000 | 1,500 | 250 | 60 | 0 |
| SG | 8,000 | 8,000 | 500 | 80 | 0 |
| MY | 15,000 | 1,500 | 250 | 60 | 0 |
| TH | 15,000 | 1,200 | 250 | 60 | 0 |
| PH | 15,000 | 2,500 | 500 | 150 | 40 |
| VN | 15,000 | 1,200 | 250 | 60 | 0 |
| TR | 15,000 | 1,200 | 250 | 60 | 0 |
| SA | 8,000 | 1,000 | 200 | 50 | 0 |
| IN | 30,000 | 1,800 | 300 | 70 | 0 |
| AU | 35,000 | 4,000 | 350 | 80 | 0 |
| BR | 30,000 | 1,500 | 250 | 60 | 0 |
| NG | 10,000 | 1,000 | 200 | 50 | 0 |
| ZA | 15,000 | 1,500 | 250 | 60 | 0 |
| RU | 30,000 | 2,000 | 300 | 70 | 0 |

Mainland China is absent from the Lite manifest and is never scheduled. The upstream policy table is not edited, which keeps the patch small and makes future upstream rebases safer.

The target manifest supplies adaptive retry tiers:

```text
micro:  48 -> 128 -> 320
city:  128 -> 384 -> 1024
region: 768 -> 2048 -> 5000
```

Overture targets start at the smallest tier with the upstream 25% source sample; if a target remains under-filled, only that target advances to 50% and then 100% while its candidate pool also grows. Geofabrik is different: a retry would rescan the same full PBF, so each shared Geofabrik group uses the final still-small tier once. Residential validation is never weakened.


### Final static output caps

Candidate size and final static size are separate controls. After the upstream importer accepts only evidenced residential records, the Lite selector keeps at most 3 records per `Region + City + Postcode` slot and also caps each target shard:

```text
micro target  -> max 6 addresses
city target   -> max 12 addresses
region target -> max 24 addresses
```

Complete 3-address postcode buckets are preferred before partial buckets. With the current 95-target whitelist, the theoretical maximum is 1,206 published addresses. This prevents a large state/territory from turning the static site back into a public-scale address pool.

## Matrix strategy

`.github/workflows/address-lite.yml` builds target groups in parallel with `max-parallel: 6`.

- Overture: distant areas use separate precise target boxes and independent temporary SQLite databases. This avoids country-wide scans and avoids same-country dataset-retirement conflicts.
- Geofabrik: targets that share a country/source extract are grouped and use the final Lite candidate tier in one pass, so the PBF is downloaded/scanned once instead of once per city or once per retry tier.
- Each temporary database exists only on the GitHub runner.
- The aggregate job receives JSON artifacts only and builds `public/data`.

## Static data layout

The output is intentionally sharded. Examples:

```text
public/data/
  countries.json
  US/
    DE.json
    OR.json
    NH.json
    MT.json
    NYC.json
    LA.json
    CHI.json
  DE/
    BUSINGEN.json
    HELGOLAND.json
    BERLIN.json
    HAMBURG.json
    MUNICH.json
  JP/
    TOKYO.json
    OSAKA.json
    YOKOHAMA.json
```

The exact paths come from `config/lite-targets.json`.

The browser loads only `countries.json` initially, then fetches the selected target shard. There is no `/web-api` dependency in the production page.

Within a shard:

```text
Region
  -> City / Locality
     -> Postcode
        -> 0..3 verified residential addresses
```

The target-level output caps above keep the whole site small even when a region contains many postcode/locality combinations.

## Build metrics

Every matrix unit writes JSON metrics plus `/usr/bin/time -v` output. The metrics include candidate tier, candidate limit, source sample percentage, accepted/rejected counts, validation success rate, postcode groups, target elapsed time, peak RSS, ETL storage estimates, post-import storage and source-size metadata. For Geofabrik, `sourceBytes` is the downloaded PBF size; for Overture, Lite requests asset-size metadata and the value represents the intersecting source-asset size estimate, not the exact HTTP range bytes DuckDB transferred. The workflow uploads all metrics for 30 days.

Use the first complete Actions run as the performance baseline. The most useful follow-up tuning is to change only the slow target's bounds or retry tiers rather than globally enlarging all countries.

## GitHub Actions use

Manual build:

1. Open **Actions -> Address Lite**.
2. Choose **Run workflow**.
3. Leave `deploy=false` for a build-only test.
4. Set `deploy=true` after VPS secrets are configured.

A weekly rebuild is configured for Sunday 03:17 UTC. Scheduled runs also attempt deployment when deployment secrets exist.

## Deployment secrets

Create the GitHub Environment `address-lite-production`, then configure:

Required:

- `VPS_HOST` - VPS hostname or IP
- `VPS_USER` - SSH user that owns the Address release directory
- `VPS_SSH_KEY` - private key for that SSH user

Optional:

- `VPS_PORT` - defaults to `22`
- `VPS_WEB_ROOT` - defaults to `/var/www/address`
- `VPS_KNOWN_HOSTS` - recommended: pinned `known_hosts` line(s) for the VPS; if omitted the workflow falls back to `ssh-keyscan`

Run `ops/address-lite/bootstrap-vps.sh` once on the VPS to create the directory layout. The user used by Actions must be able to write that directory.

## Nginx

Point the existing Nginx virtual host at:

```nginx
root /var/www/address/current;
```

A complete location example is provided in `ops/address-lite/nginx.conf.example`.

The release archive is SHA-256 verified both on the runner and again on the VPS before extraction. Deployment is atomic:

```text
upload archive to /tmp
-> extract releases/<commit>.incoming
-> validate index.html and data/countries.json
-> rename to releases/<commit>
-> atomically switch current symlink
-> retain the latest 3 releases
```

No Nginx reload is required for a normal data update because the document-root symlink remains the same path.

## Expected resource profile

These are engineering estimates until the first real GitHub Actions run produces metrics:

- VPS Address-specific resident processes: approximately 0 MB (no Address daemon)
- VPS disk: expected low tens of MB including the Astro site; address JSON itself is bounded to at most 1,206 records with the current manifest
- VPS request memory: Nginx/kernel page-cache only
- Overture Action job: DuckDB remains capped at 2 GB plus Node/Python/runtime overhead; a 16 GB standard runner has ample RAM
- Geofabrik Action job: disk/download volume can dominate because the source PBF still has to be obtained; bbox filtering reduces retained candidates and downstream work, not the remote PBF file size

The workflow is structured for the full rebuild to be controlled by the slowest groups rather than the sum of 26 countries. Actual wall-clock performance depends on Overture/Geofabrik network throughput and residential hit rate.

## Upstream updates

The Lite changes are deliberately concentrated in:

- one small core patch touching only Lite-gated ETL candidate behavior, Overture sampling/size metadata, and optional Geofabrik bounds
- `config/lite-targets.json`
- `scripts/lite/*`
- one dedicated workflow
- the static `LiteApp`

This makes rebasing onto future upstream releases easier. The installer runs `git apply --check` first; if the upstream core changed enough that the patch no longer matches, it stops instead of silently applying a damaged patch.
