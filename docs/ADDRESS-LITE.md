# Address Lite

Address Lite is an independent, ultra-light static data plane for this fork. It publishes real OpenStreetMap residential address records as static JSON and runs in production as Nginx plus static HTML, CSS, JavaScript, and JSON.

## Native pipeline

```text
config/lite-targets.json + config/lite-seeds.json
 -> scripts/lite/build-native.mjs
 -> OpenStreetMap Overpass (primary + fallback)
 -> strict residential filter -> deterministic deduplication
 -> max 3 per Region + City + Postcode slot -> target output cap
 -> Verified Data Snapshot -> Astro static build
 -> immutable Release / Deploy / Rollback -> Nginx static Production
```

The refresh runs sequential country batches. Small seed-centered probe windows are queried in two bounded passes. A normal empty result is a legitimate shortage; network or source failure fails the refresh and never becomes an empty success.

## Product contract

- 26 countries and regions, 95 curated targets; Mainland China is excluded.
- `config/lite-targets.json` is the product source of truth.
- `config/lite-seeds.json` contains only probe coordinates, never published addresses.
- Residential buildings use a strict allowlist and require `addr:housenumber` plus `addr:street` or `addr:place`.
- Bounds, region aliases, deterministic deduplication, and stable sorting are enforced locally.
- Each postcode slot contains at most three records; `micro`, `city`, and `region` caps remain 6, 12, and 24.
- A target may publish 0, 1, or 2 records when OSM coverage is insufficient.

Output JSON remains compatible with the existing static verifier and Lite application. Source attribution is OpenStreetMap ODbL 1.0.

## Fingerprints and releases

`refreshFingerprint` covers only Native Lite source code, seeds, manifest projection, and static verification inputs. `assembleFingerprint` covers aggregation and presentation metadata. UI-only changes do not trigger source refresh. Verified Snapshots support `auto` reuse, explicit `refresh`, and reassemble flows. Site Build, Release, Deploy, and Rollback remain atomic.

## Production boundary

Production runs with zero database, Node API, Python, or worker processes. The repository retains the upstream Address core for ancestry and synchronization compatibility, but Address Lite does not execute `server/database/**`, `server/sync/**`, the upstream API, or the upstream backend in its active path.

## Generic remote static deployment

Deployment uses a dedicated non-root deployment account and does not need `sudo` or root SSH. The workflow uses a pinned `DEPLOY_KNOWN_HOSTS` value and atomically switches the `current` release symlink.
