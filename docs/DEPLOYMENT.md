# Address Deployment Guide

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

This guide covers private configuration, initial data synchronization, VPS deployment, reverse proxying, upgrades, and backups. Production scripts target Linux AMD64 and ARM64 and keep all runtime state under `/root/address`.

## Requirements

- Linux VPS with AMD64 or ARM64 CPU
- 8 GB RAM for the full initial import (the Japan build peaks at roughly 6.5 GB RSS, and the sync runner refuses to start with less than 2 GiB free memory by default); 4 GB is enough for serving an already-initialized database
- At least 60 GiB available on the application volume
- `git`, `curl`, `ca-certificates`, `xz-utils`, Python 3.10 or newer (3.12 is what production runs), and `venv`
- A domain pointing to the VPS and an HTTPS-capable reverse proxy

The installer downloads the project-pinned Node.js runtime. A system-wide Node.js installation is not required.

## Storage estimate

PostgreSQL production data is stored under `/root/postgresql/data`. Initial imports temporarily retain source files and intermediate artifacts under `/root/address/data/staging`, then remove them after publication. Reserve at least 60 GiB for the database, synchronization staging, backups, and recovery; actual use depends on upstream releases, address targets, and retained snapshots.

The initial import is network- and CPU-bound: expect several hours up to more than a day on a typical VPS, and it is resumable — completed countries are skipped on restart. Korea additionally fills its postcode cache at up to 2,800 Geoapify requests per day, so KR reaches its full target over multiple daily runs after the initial gate passes.

## API keys and secrets

Runtime generation reads only verified residential records from the active PostgreSQL snapshot. China community synchronization needs one or more AMap, Baidu, or Tencent server keys, configured after deployment in `/admin/`; publication still requires multi-provider consistency.

| Variable | Required | Feature | Where to obtain it |
|---|---|---|---|
| `CONFIG_MASTER_KEY` | Required | Encrypt provider credentials in PostgreSQL control tables | Generate with `openssl rand -base64 32`; keep it server-only. |
| `ADMIN_BOOTSTRAP_PASSWORD` | Required initially | Create the first administrator identity | Generate a strong password; it is ignored after initialization. |
| `AMAP_API_KEY` / additional AMap WebService keys | China sync, server-side only | Community POI ingestion | Create Web Service keys in the [AMap console](https://lbs.amap.com/api/webservice/guide/create-project/get-key), then import the first ignored runtime value or add keys in `/admin/`. Do not reuse a browser JS key. |
| `AMAP_JS_API_KEY` | Optional initial import | Browser AMap rendering | Create a dedicated Web platform (JS API) key, restrict it to the production domain and local test origins, then import it through ignored runtime configuration or `/admin/`. |
| `AMAP_JS_SECURITY_CODE` | Required with the JS key | Authenticate AMap JS service requests | Obtain it with the JS API key. Keep it server-only; the application encrypts it and applies it through `/_AMapService`. |
| Baidu keys | China sync | Community POI ingestion and cross-validation | Create server-side Place API keys in the Baidu Maps console, then add them in `/admin/`. |
| Tencent keys | China sync | Community POI ingestion and cross-validation | Create WebService API keys in the Tencent Location Service console, then add them in `/admin/`. |
| `GEOAPIFY_API_KEY` | Required for the KR initial import | K-apt reverse-postcode geocoding (records without a validated postcode are dropped); also used for live geocoding outside China | Create a project and key using the [Geoapify guide](https://www.geoapify.com/get-started-with-maps-api/). The free tier covers the 2,800 requests/day the exporter uses. |
| `YOUDAO_APP_KEY`, `YOUDAO_APP_SECRET` | Optional pair | Backup online translation provider | Create a translation application at [Youdao AI](https://ai.youdao.com/). |
| `ONEMAP_ACCESS_TOKEN` | Optional | Broadens SG HDB building matching plus address-existence, postcode, and coordinate verification | Follow the [OneMap authentication guide](https://www.onemap.gov.sg/apidocs/authentication). Tokens are valid for 3 days and require renewal; OneMap alone does not establish residential use. |
| `GOOGLE_GEOCODING_API_KEY`, `OS_DATA_HUB_API_KEY` | Optional | Live lookup providers used by the API at runtime (not by the bulk import) | Google Cloud console and OS Data Hub respectively. |
| `SYNC_ADMIN_TOKEN` | Required on a VPS | Protect sync-control mutations | Generate locally; this is not a third-party credential. |

### Countries by credential requirement

- Zero credentials (Overture, Geofabrik/OSM, and official open data): US, CA, MX, GB, DE, FR, IT, ES, NL, RU, JP, HK, TW, TH, PH, VN, MY, SA, IN, AU, TR, BR, NG, ZA, and SG (the HDB source works without a token; `ONEMAP_ACCESS_TOKEN` only broadens coverage).
- KR: requires `GEOAPIFY_API_KEY`; without it the K-apt residential source cannot pass its quality gate and the initial import never completes.
- CN: not part of the bulk ETL. China community data is synchronized by the API process using AMap (plus optional Baidu/Tencent cross-validation) server keys configured in `/admin/`.

Public generation and IP-region generation use only the active residential PostgreSQL pool. Provider credentials are consumed by background synchronization; they are never injected into public generation requests. IP mode reports no coverage instead of substituting a region-wide or nationwide address. Set `GOOGLE_TRANSLATION_ENABLED=false` unless synchronization explicitly needs online translation.

## Secret handling

The repository templates contain placeholders only:

| Template | Purpose |
|---|---|
| `.env.example` | Local UI and API development |
| `server/sync/.env.example` | Synchronization parameter reference |
| `ops/address.env.example` | Combined VPS runtime configuration |
| `ops/deploy.env.example` | Private SSH deployment settings |

`.env`, `.deploy.env`, databases, logs, runtime state, caches, private keys, and `plan.md` are ignored by Git. Store real values only in ignored private files. Do not place secrets in browser variables, source code, screenshots, issues, command output, or CI logs.

The AMap JS API key is a browser loading parameter and is visible in browser requests by design. Treat it as a dedicated, domain-restricted public identifier rather than a reusable server credential. Its paired security code, all WebService keys, and `CONFIG_MASTER_KEY` remain server-only. The [official AMap production pattern](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode) sets `serviceHost=/_AMapService`; the Node server adds the encrypted security code and forwards only to the fixed AMap upstream.

On the VPS, use a mode-`600` runtime file:

```bash
mkdir -p /root/address/runtime
cp /root/address/app/ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
```

Generate the encryption key and sync token without printing them:

```bash
token="$(openssl rand -hex 32)"
master_key="$(openssl rand -base64 32)"
sed -i "s/GENERATE_A_RANDOM_VALUE/$token/" /root/address/runtime/address.env
sed -i "s/GENERATE_32_BYTE_BASE64_VALUE/$master_key/" /root/address/runtime/address.env
unset token master_key
chmod 600 /root/address/runtime/address.env
```

At minimum, replace `YOUR_DOMAIN.example`, generate `CONFIG_MASTER_KEY` and `SYNC_ADMIN_TOKEN`, set the one-time administrator password, and review `TRUST_PROXY`. Add map keys through `/admin/`; they must not be written to Git-tracked files.

## Runtime configuration

| Variable | Production default | Purpose |
|---|---|---|
| `PUBLIC_API_BASE_URL` | `/web-api` | Session-protected API prefix used by the browser |
| `API_HOST` | `127.0.0.1` | Hono listen address |
| `API_PORT` | `8787` | Hono listen port |
| `STATIC_ROOT` | `/root/address/app/dist` | Built Astro site |
| `POSTGRES_URL` | `postgresql://address:...@127.0.0.1:5432/address` | PostgreSQL connection string; keep it only in server runtime configuration |
| `POSTGRES_POOL_MAX` / `POSTGRES_POOL_MIN` | `64` / `4` | Application connection-pool bounds |
| `CONFIG_MASTER_KEY` | Generated server-only value | AES-256-GCM key for provider credentials and AMap JS security configuration |
| `AMAP_JS_API_KEY` | Empty | Optional first-import value for the dedicated browser JS API key |
| `AMAP_JS_SECURITY_CODE` | Empty | Optional first-import value for the server-only JS security code |
| `ADMIN_BOOTSTRAP_PASSWORD` | One-time strong password | Creates the initial administrator identity |
| `COOKIE_SECURE` | `true` | Send authentication cookies only over HTTPS |
| `ALLOWED_ORIGIN` | Your HTTPS origin | CORS allowlist |
| `TRUST_PROXY` | `true` behind the proxy | Trust forwarded client IP headers |
| `SYNC_HOST` | `127.0.0.1` | Sync-control listen address |
| `SYNC_PORT` | `8791` | Sync-control port |
| `SYNC_CONTROL_PUBLIC` | `false` | Keep sync management off the public API |
| `SYNC_SCHEDULER_ENABLED` | `true` | Let the sync service auto-complete the initial import and run daily updates |
| `SYNC_UTC_HOUR` | `3` | Daily scheduler check hour in UTC |

Only enable `TRUST_PROXY` when a controlled reverse proxy overwrites forwarded IP headers. Keep port `8791` private.

Map display switches are stored in the control database and managed in `/admin/`. Google and AMap each have independent China and overseas switches. The default is Google enabled and AMap disabled for both regions. Enabling overseas AMap requires [World Map](https://lbs.amap.com/api/javascript-api-v2/guide/map/world-map) permission; without that permission, keep the overseas AMap switch off.

For AreaCity, download and extract `ok_data_level4.csv` into `/root/address/data/imports/`, then use **China Sync → Import AreaCity** in `/admin/` with source `imports/ok_data_level4.csv` and the release version. An HTTPS JSON/CSV URL is also accepted; local paths are restricted to the data directory.

## First deployment

### 1. Prepare the VPS

```bash
apt-get update
apt-get install -y git curl ca-certificates xz-utils python3 python3-venv nginx
mkdir -p /root/address
git clone https://github.com/daimon3332/address.git /root/address/app
cd /root/address/app
./ops/install-runtime.sh
```

`install-runtime.sh` installs the pinned Node.js runtime, Python virtual environment, Python dependencies, and npm dependencies under `/root/address`.

### 2. Configure private runtime values

```bash
mkdir -p /root/address/runtime
cp ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
editor /root/address/runtime/address.env
```

Set `ALLOWED_ORIGIN=https://YOUR_DOMAIN.example`, create `SYNC_ADMIN_TOKEN`, and add only the optional provider credentials you need.

### 3. Build the WebUI

```bash
export PATH=/root/address/runtime/node/bin:$PATH
cd /root/address/app
npm run build
```

### 4. Seed the location catalog

```bash
export PATH=/root/address/runtime/node/bin:$PATH
cd /root/address/app
. ops/env.sh
npm run data:catalog
npm run data:catalog:import
```

`data:catalog` downloads open region/city/postcode reference data (countries-states-cities-database plus GeoNames, several hundred MB) into `.data-cache/catalog-seed.sql`; `data:catalog:import` writes it to the database selected by `POSTGRES_URL`. This step is required before the first address import: the ETL reverse-geocodes records against the catalog tables, and an empty catalog sharply lowers acceptance.

### 5. Initialize all countries

With `SYNC_SCHEDULER_ENABLED=true` (the template default), starting the services is enough — the sync service automatically runs the resumable initial import and retries failures with backoff:

```bash
/root/address/app/ops/start.sh
```

To run the initial import in the foreground first instead (the supervisor must be stopped), use:

```bash
/root/address/app/ops/initial-sync.sh
tail -f /root/address/logs/initial-sync.log
```

Each country is validated and published independently, and completed cache entries are reusable after a restart. Runtime depends on VPS CPU, storage, network, and upstream availability (typically several hours to more than a day). The API serves whatever countries are already published while the import continues.

### 6. Verify the services

```bash
/root/address/app/ops/status.sh
curl -fsS http://127.0.0.1:8787/api/v1/health
curl -fsS http://127.0.0.1:8787/api/v1/data-health
```

## Nginx and HTTPS

Use your existing TLS workflow and proxy the public domain to the API process:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN.example;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Expose only HTTP/HTTPS in the firewall. Keep the API and sync-control listeners on loopback. After TLS is active, use the exact HTTPS origin for `ALLOWED_ORIGIN`.

## Synchronization and operations

- The initial job covers the 26 ETL countries (China is synchronized separately by the API process) and resumes completed work.
- The steady-state scheduler requires `SYNC_SCHEDULER_ENABLED=true`; it checks at 03:00 UTC and updates at most one due country per day.
- Each successful country snapshot becomes due again after 30 days.
- Failed snapshots never replace the current active data.
- Raw source files are removed after publication unless retention is explicitly enabled.

```bash
# Service lifecycle
/root/address/app/ops/start.sh
/root/address/app/ops/stop.sh
/root/address/app/ops/status.sh

# PostgreSQL custom-format backup
/root/address/app/ops/backup.sh

# Restore a backup stored under /root/address/backups
/root/address/app/ops/restore.sh /root/address/backups/ADDRESS_BACKUP.dump
```

Backup notes:

- `backup.sh` uses `pg_dump --format=custom`; the restore script uses `pg_restore --clean --if-exists`.
- Exclude `data/staging` (`ADDRESS_SYNC_CACHE_DIR`) from any backup: it holds only re-downloadable source artifacts and can be tens of GiB during an import.
- A single backup contains address tables, control tables, encrypted credentials, synchronization state, and audit data. Keep files at mode `600` and verify them periodically with `pg_restore --list`.
- PostgreSQL uses `max_connections=256`; the application pool defaults to maximum 64 and minimum 4, configurable through `POSTGRES_POOL_MAX` and `POSTGRES_POOL_MIN`.

The project supervisor (`ops/supervisor.mjs`, started by `ops/start.sh`) runs and restarts two processes: the API server (`server/api/server.ts`, port `8787`) and the sync service (`server/sync/index.mjs`, port `8791`). It is process-based and does not install systemd or cron entries. Connect `ops/start.sh` to the VPS's existing boot mechanism when automatic restart after a host reboot is required.

## Deploy subsequent commits

On the development machine:

```bash
cp ops/deploy.env.example .deploy.env
chmod 600 .deploy.env
editor .deploy.env
bash ops/deploy.sh --dist
```

The deployment script archives the current `HEAD`, uploads it through SSH, preserves the VPS database, private runtime file, and server blacklist, restarts the supervisor, and performs a health check. Use `--no-restart` for documentation-only changes.

## Production checklist

- DNS and HTTPS are active.
- `ALLOWED_ORIGIN` is the exact public HTTPS origin.
- `TRUST_PROXY=true` is used only behind the controlled proxy.
- `SYNC_ADMIN_TOKEN` is random, private, and absent from Git history.
- `SYNC_CONTROL_PUBLIC=false` and port `8791` is not public.
- Optional provider keys have provider-side restrictions and usage alerts.
- The AMap JS key is dedicated and domain-restricted; its security code is absent from browser responses, logs, and Git.
- Overseas AMap is enabled only after World Map permission is confirmed; all four map switches were tested.
- `npm run check:production` passes after the database is initialized.
- A current backup exists and restore has been tested.
- At least 60 GiB is allocated and free-space monitoring is enabled.
