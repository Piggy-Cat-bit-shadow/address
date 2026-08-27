# Address Deployment

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

The project maintains one production deployment path: Docker Compose. The root `docker-compose.yml` manages the application, PostgreSQL, migrations, and automatic synchronization.

## Docker Compose quick deployment

```bash
mkdir address && cd address
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/daimon3332/address/main/docker-compose.yml
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/api/v1/ready
```

The Compose bootstrap service creates relative directories and persistent internal secrets automatically. The default administrator password is `admin`; the frontend password is disabled. Edit `ADMIN_INITIAL_PASSWORD` or `FRONTEND_INITIAL_PASSWORD` in `docker-compose.yml` before the first start if needed. After signing in, change the default administrator password before using other administrator features.

```bash
cat data/secrets/admin_bootstrap_password
```

After signing in to `/admin/`, manage the frontend password, administrator password, API token, provider keys, quotas, and business settings there.

## Requirements

- Linux AMD64 or ARM64
- Docker Engine and Docker Compose v2
- 4 GB RAM; 8 GB or more is recommended for large initial country imports
- Enough disk space for PostgreSQL, address data, synchronization staging, and backups
- An HTTPS reverse proxy

The development computer does not need Docker. GitHub Actions builds the production image and publishes it to Docker Hub as `daimon23/address`.

## Directory Layout

```text
address/
├── docker-compose.yml    # The only required deployment file
├── config/secrets/       # Optional legacy secret import location
├── data/secrets/         # Automatically generated persistent secrets
├── data/address/         # Address pool and synchronization staging
├── data/postgres/        # PostgreSQL data
├── runtime/              # Synchronization runtime state
├── backups/              # pg_dump backups
└── logs/
```

Every mount is relative to the Compose directory. No `/root/address` or other fixed installation path is required. Never attach one `data/postgres` directory to two PostgreSQL containers.

## Optional Deployment Settings

The defaults start without an `.env` file. Edit the Compose `environment` values directly, or create one only to override the image, port, or reverse-proxy settings:

```bash
cp ops/compose.env.example .env
```

```dotenv
ADDRESS_IMAGE=daimon23/address:latest
API_BIND_ADDRESS=127.0.0.1
API_PORT=8787
ALLOWED_ORIGINS=*
TRUST_PROXY=false
COOKIE_SECURE=false
```

For production behind HTTPS, set `ALLOWED_ORIGINS` to one or more comma-separated HTTPS origins and set `TRUST_PROXY` and `COOKIE_SECURE` to `true`. Manage provider API keys and ordinary business settings in the administrator console.

## Services and Network

- `postgres`: PostgreSQL 16 on the internal network only
- `bootstrap`: creates or validates persistent internal secrets, then exits
- `migrate`: runs database migrations once before application startup
- `api`: WebUI and API, bound to `127.0.0.1:8787` by default
- `sync`: automatic synchronization on the private Compose network
- `credential-broker`: encrypted credential rotation and quota coordination on the private Compose network

Automatic synchronization is enabled by default. Queue discovery, timeouts, bounded retries, cooldowns, source exhaustion, and temporary-file cleanup are handled by the service.

## Operations

```bash
docker compose ps
docker compose logs -f api sync
docker compose restart api sync
docker compose down
docker compose up -d
```

Upgrade the image:

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "backups/address-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose pull
docker compose up -d
docker compose ps
```

## Backup and Restore

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "backups/address-$(date -u +%Y%m%dT%H%M%SZ).dump"

docker compose stop api sync credential-broker
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < ./backups/address-YYYYMMDDTHHMMSSZ.dump
docker compose up -d
```

A backup contains addresses, control data, encrypted credentials, synchronization state, and audit records. Securely retain `data/secrets/config_master_key` with the database backup or stored provider credentials cannot be decrypted. PostgreSQL major-version upgrades require `pg_dump` and `pg_restore`; do not reuse the data directory directly.

## Nginx Example

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

Expose only HTTP/HTTPS. Do not publish the PostgreSQL or synchronization service ports.

## Docker Hub Publishing

`.github/workflows/docker-publish.yml` builds AMD64/ARM64 images after updates to `main`, version tags, or manual dispatch. Configure the `DOCKERHUB_TOKEN` GitHub repository secret with a Docker Hub read/write access token. The public Docker Hub username is fixed to `daimon23` in the workflow.

Keep the token only in GitHub Actions Secrets. Never put it in the repository, Compose, screenshots, or logs.
