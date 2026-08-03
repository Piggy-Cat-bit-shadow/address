#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/env.sh"

source_file=${1:-}
case "$source_file" in
  "$ROOT"/backups/*.dump) ;;
  *) echo "Backup must be under $ROOT/backups" >&2; exit 1 ;;
esac
test -f "$source_file"
"$APP/ops/stop.sh"
POSTGRES_ROOT=${POSTGRES_ROOT:-/root/postgresql}
set -a
. "$POSTGRES_ROOT/.env"
set +a
docker compose -f "$POSTGRES_ROOT/docker-compose.yml" --env-file "$POSTGRES_ROOT/.env" \
  exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner <"$source_file"
"$APP/ops/start.sh"
