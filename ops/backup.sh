#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/compose-root.sh"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$ROOT/backups/address-$timestamp.dump"
temporary="$target.tmp"
mkdir -p "$ROOT/backups"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6' >"$temporary"
docker compose -f "$COMPOSE_FILE" exec -T postgres pg_restore --list <"$temporary" >/dev/null
mv "$temporary" "$target"
chmod 600 "$target"
trap - EXIT HUP INT TERM
echo "$target"
