#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/compose-root.sh"

source_file=${1:-}
case "$source_file" in
  "$ROOT"/backups/*.dump) ;;
  *) echo "Backup must be under $ROOT/backups" >&2; exit 1 ;;
esac
test -f "$source_file"
compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}
restart_services() {
  compose up -d api sync
}
compose stop api sync
trap restart_services EXIT HUP INT TERM
compose exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' <"$source_file"
compose run --rm migrate
restart_services
trap - EXIT HUP INT TERM
