# Address Deployment Guide

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

This guide covers private configuration, initial data synchronization, VPS deployment, reverse proxying, upgrades, and backups. Production scripts target Linux AMD64 and ARM64 and keep all runtime state under `/root/address`.

## Requirements

- Linux VPS with AMD64 or ARM64 CPU
- At least 4 GB RAM; 8 GB is recommended for the full initial import
- At least 60 GiB available on the application volume
- `git`, `curl`, `ca-certificates`, `xz-utils`, Python 3, and `venv`
- A domain pointing to the VPS and an HTTPS-capable reverse proxy

The installer downloads the project-pinned Node.js runtime. A system-wide Node.js installation is not required.

## Storage estimate

Measured on 2026-07-23 after all 27 countries were synchronized at commit `084805e`:

| Item | Measured size |
|---|---:|
| `address.sqlite` | 6.90 GiB |
| Active SQLite WAL | 0.68 GiB |
| Complete `data/` directory | 7.89 GiB |
| Active addresses | 722,950 records |
| Legacy China residential subset | 174,327 records (historical measurement; not the new POI pool) |

The new China POI pool grows after AMap, Baidu, or Tencent synchronization, so its final count and size depend on configured cities, page limits, and provider results. The initial import temporarily retains source downloads and intermediate files. The observed legacy peak was about 11.2 GiB. Upstream releases, WAL activity, and optional retention settings change the actual total. The 60 GiB recommendation leaves room for synchronization, backups, and recovery. Shadow expansion stops at 40 GiB, writes stop before 45 GiB, and the project keeps a 50 GiB absolute ceiling.

## API keys and secrets

Runtime generation reads only verified residential records from the active SQLite snapshot. China community synchronization needs one or more AMap, Baidu, or Tencent server keys, configured after deployment in `/admin/`; publication still requires multi-provider consistency.

| Variable | Required | Feature | Where to obtain it |
|---|---|---|---|
| `CONFIG_MASTER_KEY` | Required | Encrypt provider credentials in `control.sqlite` | Generate with `openssl rand -base64 32`; keep it server-only. |
| `ADMIN_BOOTSTRAP_PASSWORD` | Required initially | Create the first administrator identity | Generate a strong password; it is ignored after initialization. |
| `AMAP_API_KEY` / additional AMap WebService keys | China sync, server-side only | Community POI ingestion | Create Web Service keys in the [AMap console](https://lbs.amap.com/api/webservice/guide/create-project/get-key), then import the first ignored runtime value or add keys in `/admin/`. Do not reuse a browser JS key. |
| `AMAP_JS_API_KEY` | Optional initial import | Browser AMap rendering | Create a dedicated Web platform (JS API) key, restrict it to the production domain and local test origins, then import it through ignored runtime configuration or `/admin/`. |
| `AMAP_JS_SECURITY_CODE` | Required with the JS key | Authenticate AMap JS service requests | Obtain it with the JS API key. Keep it server-only; the application encrypts it and applies it through `/_AMapService`. |
| Baidu keys | China sync | Community POI ingestion and cross-validation | Create server-side Place API keys in the Baidu Maps console, then add them in `/admin/`. |
| Tencent keys | China sync | Community POI ingestion and cross-validation | Create WebService API keys in the Tencent Location Service console, then add them in `/admin/`. |
| `GEOAPIFY_API_KEY` | Optional | Live geocoding outside China and selected reverse localization | Create a project and key using the [Geoapify guide](https://www.geoapify.com/get-started-with-maps-api/). |
| `YOUDAO_APP_KEY`, `YOUDAO_APP_SECRET` | Optional pair | Backup online translation provider | Create a translation application at [Youdao AI](https://ai.youdao.com/). |
| `ONEMAP_ACCESS_TOKEN` | Optional | Singapore address-existence, postcode, and coordinate verification | Follow the [OneMap authentication guide](https://www.onemap.gov.sg/apidocs/authentication). Tokens are valid for 3 days and require renewal; OneMap alone does not establish residential use. |
| `SYNC_ADMIN_TOKEN` | Required on a VPS | Protect sync-control mutations | Generate locally; this is not a third-party credential. |

Keep `LIVE_API_MODES=ip-region` to restrict live providers to IP coordinate/city matching. Standard public generation uses the active residential SQLite pool, and every live candidate must pass the same address-existence and residential-evidence gates. IP mode reports no coverage instead of substituting a region-wide or nationwide address. Set `GOOGLE_TRANSLATION_ENABLED=false` unless online translation is explicitly needed.

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
| `ADDRESS_DATABASE_PATH` | `/root/address/data/address.sqlite` | SQLite database |
| `CONTROL_DATABASE_PATH` | `/root/address/data/control.sqlite` | Authentication, encrypted credentials, quotas, jobs, and audit database |
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

### 4. Initialize all countries

```bash
/root/address/app/ops/initial-sync.sh
tail -f /root/address/logs/initial-sync.log
```

The job runs in the background. Each country is validated and published independently, and completed cache entries are reusable after a restart. Runtime depends on VPS CPU, storage, network, and upstream availability. The API and scheduler start after a successful initial run.

### 5. Verify the services

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

- The initial job processes all 27 countries and resumes completed work.
- The steady-state scheduler checks at 03:00 UTC and updates at most one due country per day.
- Each successful country snapshot becomes due again after 30 days.
- Failed snapshots never replace the current active data.
- Raw source files are removed after publication unless retention is explicitly enabled.

```bash
# Service lifecycle
/root/address/app/ops/start.sh
/root/address/app/ops/stop.sh
/root/address/app/ops/status.sh

# Consistent SQLite backup
/root/address/app/ops/backup.sh

# Restore a backup stored under /root/address/backups
/root/address/app/ops/restore.sh /root/address/backups/ADDRESS_BACKUP.sqlite
```

The project supervisor is process-based and does not install systemd or cron entries. Connect `ops/start.sh` to the VPS's existing boot mechanism when automatic restart after a host reboot is required.

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
