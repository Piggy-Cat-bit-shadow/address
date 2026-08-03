<p align="center"><img src="public/favicon.svg" width="88" height="88" alt="Address logo" /></p>
<h1 align="center">Address</h1>
<p align="center">Self-hosted residential-address and synthetic test-profile generation backed by PostgreSQL.</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/daimon3332/address/actions/workflows/ci.yml"><img src="https://github.com/daimon3332/address/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Code-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://address.333186.xyz"><img src="https://img.shields.io/badge/Live-address.333186.xyz-1769e0" alt="Live demo" /></a>
</p>

**A typical completed deployment uses approximately 5 GB of disk space for the application and PostgreSQL address database. Active synchronization requires additional temporary space.**

## Highlights

- 27 configured countries and regions with country, administrative-area, city, district, and postcode filters where supported.
- Strict filter semantics: an empty matching pool returns an error instead of silently switching to another location.
- Fast database-backed random selection across the complete eligible scope; it does not repeatedly read the first rows.
- Source/native, English, Simplified Chinese, Traditional Chinese, Japanese, Korean, German, French, Spanish, and Portuguese presentation paths.
- Address and profile language choices persist independently in the browser; first use defaults to English.
- Popular administrative areas, popular cities, and special areas are configurable per country. The United States includes states without statewide sales tax.
- Public coverage monitor plus administrator dashboard, address-data rules, synchronization queue, quick-location editor, provider credentials, access control, blacklist, and API tokens.
- PostgreSQL-only runtime with pooled connections, transactional publication, indexed location search, and prebuilt random-address indexes.

## Supported scope

| Region | Countries and regions |
|---|---|
| North America | US, CA, MX |
| Europe | GB, DE, FR, IT, ES, NL, RU |
| East Asia | CN, HK, TW, JP, KR |
| Southeast Asia | SG, MY, TH, PH, VN |
| South Asia | IN |
| Oceania | AU |
| Middle East | TR, SA |
| South America | BR |
| Africa | NG, ZA |

## Architecture

```text
Astro static pages + React UI
             │
             ▼
       Hono Node.js API
        ├─ PostgreSQL address and control data
        ├─ in-memory random/filter indexes rebuilt from PostgreSQL
        └─ local formatting, profile generation, and optional translation

Synchronization supervisor
        ├─ resumable bulk/API adapters
        ├─ country-specific validation and residential evidence gates
        ├─ transactional PostgreSQL publication
        └─ coverage statistics and bounded queue state
```

## Automated synchronization

A country is complete only when every enabled rule passes:

1. total eligible-record target;
2. lowest administrative-level coverage and per-node minimums;
3. level-1 and level-2 minimums where configured;
4. every explicit node override.

Reaching only the total target does not mark a country complete. Conversely, a source proven to be exhausted is kept visible as incomplete but removed from active work until its source/version fingerprint changes.

The queue applies bounded retries, exponential backoff, cooldown/quota reset times, no-progress latching, and suspension after repeated failures. It cannot run the same unchanged no-progress source indefinitely. China receives the highest automatic priority while it remains eligible.

## Screenshots

<table>
  <tr><th>United States generator</th><th>China generator</th></tr>
  <tr>
    <td><img src="image/webui-us-overview.png" alt="United States generator" /></td>
    <td><img src="image/webui-cn-overview.png" alt="China generator" /></td>
  </tr>
</table>

### Data monitor

<img src="image/webui-monitor.png" alt="Public address-count and administrative-coverage monitor" />

### Administrator console

<table>
  <tr><th>Dashboard</th><th>Address data</th></tr>
  <tr>
    <td><img src="image/admin-dashboard.png" alt="Administrator dashboard" /></td>
    <td><img src="image/admin-address-data.png" alt="Address data administration" /></td>
  </tr>
  <tr><th>Synchronization queue</th><th>Quick locations</th></tr>
  <tr>
    <td><img src="image/admin-sync-queue.png" alt="Synchronization queue and completion rules" /></td>
    <td><img src="image/admin-quick-locations.png" alt="Quick locations with searchable availability counts" /></td>
  </tr>
</table>

<img src="image/admin-map-keys.png" alt="Masked map-key and quota administration" />

## Quick start

Requirements: Node.js 24+, Docker Compose, and enough disk space for the datasets you choose to import.

```bash
git clone https://github.com/daimon3332/address.git
cd address

cd ops/postgresql
POSTGRES_PASSWORD='REPLACE_WITH_A_STRONG_PASSWORD' docker compose up -d
cd ../..

cp .env.example .env
# Set POSTGRES_URL, CONFIG_MASTER_KEY, and ADMIN_BOOTSTRAP_PASSWORD in .env.
npm ci
npm run db:migrate
npm run build
npm start
```

The initial database contains schema only. Import only the countries and sources whose licenses, resource requirements, and strategy documents you have reviewed. Production deployment, service supervision, reverse proxy, backup, and restore procedures are in the [deployment guide](docs/DEPLOYMENT.md).

## Configuration and API keys

- Copy `.env.example`; never commit `.env`.
- Provider keys are optional unless the selected synchronization strategy needs them.
- Multiple credentials rotate independently. A failing key is cooled down while another available key is tried; when all keys are unavailable, work waits for the earliest reset.
- Encrypted administrator credentials depend on a stable `CONFIG_MASTER_KEY`.
- Follow the dedicated [API key configuration guide](docs/API_KEYS.md) for official application links, variable names, restrictions, and rotation behavior.

## Documentation

| Document | Purpose |
|---|---|
| [API reference](docs/API.md) | Bearer authentication, generation, filtering, errors, and monitoring |
| [API keys](docs/API_KEYS.md) | Provider registration, environment variables, encryption, rotation, and cooldown |
| [Deployment](docs/DEPLOYMENT.md) | PostgreSQL, VPS layout, process control, Nginx, backup, restore, and upgrades |
| [Development](docs/DEVELOPMENT.md) | Architecture, local checks, extension points, and release gates |
| [Address formats](docs/address-formats.md) | Country formatting and field behavior |
| [Country strategies](docs/strategies/) | Source, evidence, coordinates, deduplication, validation, and update policy |

## License

Project source code is licensed under [MIT](LICENSE). Upstream datasets retain their own licenses and attribution requirements.
