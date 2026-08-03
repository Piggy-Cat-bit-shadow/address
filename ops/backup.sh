#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$ROOT/backups/address-$timestamp.dump"
set -a
. /root/postgresql/.env
set +a
docker compose -f /root/postgresql/docker-compose.yml --env-file /root/postgresql/.env \
  exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 >"$target"
chmod 600 "$target"
echo "$target"
