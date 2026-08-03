#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

source_file=${1:-}
case "$source_file" in
  "$ROOT"/backups/*.dump) ;;
  *) echo "Backup must be under $ROOT/backups" >&2; exit 1 ;;
esac
test -f "$source_file"
"$APP/ops/stop.sh"
set -a
. /root/postgresql/.env
set +a
docker compose -f /root/postgresql/docker-compose.yml --env-file /root/postgresql/.env \
  exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner <"$source_file"
"$APP/ops/start.sh"
