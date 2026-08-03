#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/env.sh"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$ROOT/backups/address-$timestamp.dump"
POSTGRES_ROOT=${POSTGRES_ROOT:-/root/postgresql}
set -a
. "$POSTGRES_ROOT/.env"
set +a
docker compose -f "$POSTGRES_ROOT/docker-compose.yml" --env-file "$POSTGRES_ROOT/.env" \
  exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 >"$target"
chmod 600 "$target"
echo "$target"
