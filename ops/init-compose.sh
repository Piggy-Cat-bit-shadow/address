#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/compose-root.sh"
SECRET_ROOT=$ROOT/config/secrets
mkdir -p "$SECRET_ROOT" "$ROOT/data/address" "$ROOT/data/postgres" "$ROOT/runtime" "$ROOT/backups" "$ROOT/logs"
chmod 0700 "$SECRET_ROOT"
[ -e "$ROOT/config/address.env" ] || : >"$ROOT/config/address.env"
chmod 0600 "$ROOT/config/address.env"

create_secret() {
  file=$1
  bytes=$2
  [ -s "$file" ] || { openssl rand -base64 "$bytes" | tr -d '\n' >"$file"; chmod 0600 "$file"; }
}

create_secret "$SECRET_ROOT/postgres_password" 36
create_secret "$SECRET_ROOT/config_master_key" 32
create_secret "$SECRET_ROOT/admin_bootstrap_password" 24
create_secret "$SECRET_ROOT/sync_admin_token" 36
create_secret "$SECRET_ROOT/credential_broker_production_token" 36
create_secret "$SECRET_ROOT/credential_broker_test_token" 36

printf 'Compose directories and secrets are ready in %s\n' "$ROOT"
printf 'Initial administrator password: %s\n' "$SECRET_ROOT/admin_bootstrap_password"
printf 'Start with: docker compose -f %s/docker-compose.yml up -d\n' "$ROOT"
