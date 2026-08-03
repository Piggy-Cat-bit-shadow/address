# Address Development Guide

[English](DEVELOPMENT.md) · [简体中文](DEVELOPMENT.zh-CN.md) · [繁體中文](DEVELOPMENT.zh-TW.md)

## Architecture

```text
Browser
  -> Astro static pages + React WebUI
  -> Hono Node.js API
       -> PostgreSQL transactional address pool
       -> PostgreSQL coordinate coordinate index
       -> local formatting and localization
       -> synchronized residential pool only
  -> synchronization supervisor
       -> DuckDB reads Overture GeoParquet
       -> pyosmium reads Geofabrik/OSM PBF
       -> validation and atomic country snapshot publication
```

Public generation and IP-region generation read only verified residential records from the active PostgreSQL pool. Provider integrations belong to background synchronization and are not called by public generation requests.

Map rendering is isolated from address verification. Google uses a coordinate preview; AMap uses a dedicated JS API key plus the same-origin `/_AMapService` proxy. The AMap JS security code remains encrypted in the control database and never enters the browser bundle or map-configuration response.

## Repository layout

| Path | Responsibility |
|---|---|
| `src/components/` | React WebUI and synchronization administration UI |
| `src/domain/` | Country metadata, generation, formatting, localization, profile, and export rules |
| `src/pages/` | Astro routes for localized WebUI and API documentation |
| `server/api/` | Hono application, repositories, and external-provider adapters |
| `server/database/` | PostgreSQL schema and migration entry point |
| `server/sync/` | Source adapters, ETL, scheduler, snapshot publication, and sync-control API |
| `scripts/` | Catalog generation, validation, live probes, and release audits |
| `ops/` | Linux VPS installation, process, backup, restore, and deployment scripts |
| `tests/` | Vitest unit, integration, data-quality, and UI-structure tests |

## Local setup

Node.js 24 or newer is required. Python 3.10 or newer (3.12 tested) and `venv` are required only for source synchronization; install its dependencies with `pip install -r server/sync/requirements.txt` and point `PYTHON_BIN` at that interpreter.

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

`npm run dev` builds the WebUI once and serves it through the Hono API on `127.0.0.1:8787`. For live UI editing, run `npm run dev:api` plus `npm run dev:web`: the Astro development server on `127.0.0.1:4321` proxies `/api` to Hono and `/sync-control` to the local synchronization service on `127.0.0.1:8791`.

A freshly migrated database has schema only and does not contain an address pool. Local development and the test suite run against this empty schema plus the small fixtures in `scripts/fixtures/` and `tests/fixtures/`; the production PostgreSQL data never leaves the server (`data/` is gitignored and deployments preserve the server database). To exercise real data locally, seed the catalog (`npm run data:catalog` then `npm run data:catalog:import`) and import one small country, for example `npm run data:address-pool:etl -- --manual --shard SG`.

Useful commands:

| Command | Purpose |
|---|---|
| `npm run dev` | Build the WebUI once, then run the Hono API in watch mode |
| `npm run dev:web` | Run only Astro (port 4321, proxies `/api`) |
| `npm run dev:api` | Run only Hono |
| `npm test` | Run the Vitest suite |
| `npm run db:migrate` | Create or migrate the local PostgreSQL schema |
| `npm run data:regions` | Refresh bundled region metadata |
| `npm run data:catalog` | Download and build the location-catalog seed |
| `npm run data:catalog:import` | Import the catalog seed into the local database (required before any address import) |
| `npm run data:address-pool:estimate` | Estimate a synchronization plan |
| `npm run data:address-pool:sync:dry-run` | Validate ETL planning without publication |
| `npm run data:address-pool:bootstrap` | Run the resumable all-country initial import |
| `npm run sync:serve` | Run the local scheduler and sync-control API |

## Configuration model

Copy `.env.example` to the ignored `.env` file. Keep secrets server-side. Only variables explicitly prefixed for Astro's public environment are eligible for browser bundling; third-party provider keys and `SYNC_ADMIN_TOKEN` must remain in the API/sync process environment. `AMAP_API_KEY` is a server-side WebService credential. `AMAP_JS_API_KEY` is a separate domain-restricted browser loading key, while `AMAP_JS_SECURITY_CODE` remains server-side and is applied only by `/_AMapService`.

Regular development needs no third-party API key. Optional synchronization integrations are documented in the [deployment guide](DEPLOYMENT.md).

## Database and synchronization

PostgreSQL uses transactions and connection pooling and stores address records, localization, source evidence, country state, and indexed coordinates. Country publication is transactional: a candidate snapshot is validated before it replaces the active country dataset, and a failed candidate leaves the previous snapshot available.

Synchronization sources:

- Overture Maps: DuckDB remotely filters and reads GeoParquet.
- OpenStreetMap via Geofabrik: pyosmium streams prefiltered PBF nodes and ways.
- Local region and location catalogs: constrain selectors and validate administrative consistency.

The pipeline filters institutional/non-address features, deduplicates records, checks residential evidence, validates localized components, and enforces storage budgets. Do not edit the production database manually while the API or synchronization job is active.

Manual examples:

```bash
node server/sync/address-etl.mjs --initial --all
node server/sync/address-etl.mjs --daily --all
node server/sync/address-etl.mjs --manual --shard US
```

## Extending the public API

1. Define request validation and the route in `server/api/index.ts`.
2. Keep database access behind `server/api/repositories/`.
3. Put provider/network logic in `server/api/services/` with explicit timeouts.
4. Return the existing `{ data: ... }` or `{ error: { code, message } }` envelope.
5. Add API tests and update all three API documents.

Public errors should use stable machine-readable codes. Do not make callers branch on localized UI strings.

## Extending countries or address rules

Country behavior spans metadata, formatting, location options, localization, postal rules, source shard planning, and test expectations. Before adding a country:

1. Define its metadata and supported filters in `src/domain/`.
2. Add formatting and postcode behavior.
3. Add a source shard and verify licensing/attribution metadata.
4. Validate address-existence evidence and independent residential-use evidence for the same address/building relation.
5. Add localization, deterministic selection, exact-or-empty filtering, IP coordinate/city matching, and postal-format tests.
6. Regenerate catalogs only through the existing scripts.

All address and indoor fields must stay source-backed; missing values remain empty. Synthetic profile data must remain explicitly separate from address provenance.

## WebUI development

Localized pages enter through `src/pages/[locale].astro` and mount `src/components/App.tsx`. Shared presentation rules live in `src/styles/global.css`; the synchronization surface uses `SyncAdmin.tsx` and `admin.css`.

When changing result fields, update the domain type first, then generation, API serialization, UI rendering, exports, translations, and tests as one contract. Preserve stable result-section dimensions and verify both English and Chinese values.

Map display has four independent booleans: Google/AMap for China and Google/AMap for overseas addresses. Defaults are Google on and AMap off. China coordinates are converted from WGS-84 to GCJ-02 for AMap; overseas AMap uses the source coordinate with `showOversea` and therefore requires World Map permission. Provider components must fail independently so one unavailable map does not blank the result page.

## Validation and release gate

Run before every commit:

```bash
npm test
npm run check
npm run build
npm run check:public
```

These commands cover Vitest, Astro diagnostics, TypeScript, production bundling, ignored-file policy, required public files, and common secret shapes. On Linux, CI also validates shell syntax and compiles Python files.

After a full database is synchronized, run:

```bash
npm run check:production
```

This checks database integrity, required tables, country readiness, and storage ceilings. Live-environment probes are separate commands because they require a running deployment.

## Contribution checklist

- Keep changes scoped and avoid unrelated dependency or formatting churn.
- Add tests proportional to the behavioral change.
- For map changes, cover all four regional/provider switches, persisted administrator settings, masked credentials, proxy host allowlisting, and the absence of the AMap security code from browser responses and logs.
- Update English, Simplified Chinese, and Traditional Chinese documentation together.
- Keep real credentials, databases, logs, screenshots with private data, and runtime state out of Git.
- Run `git diff --check` in addition to the project commands.
- Preserve source attribution and licenses when changing the data pipeline.
