#!/bin/sh
set -eu

read_secret() {
  variable=$1
  file_variable="${variable}_FILE"
  eval "file=\${$file_variable:-}"
  if [ -n "$file" ]; then
    [ -r "$file" ] || { echo "$file_variable is not readable" >&2; exit 1; }
    value=$(cat "$file")
    export "$variable=$value"
  fi
}

for variable in CONFIG_MASTER_KEY ADMIN_BOOTSTRAP_PASSWORD SYNC_ADMIN_TOKEN; do
  read_secret "$variable"
done

if [ -n "${POSTGRES_URL_FILE:-}" ]; then
  read_secret POSTGRES_URL
elif [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then
  password=$(cat "$POSTGRES_PASSWORD_FILE")
  encoded=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$password")
  export POSTGRES_URL="postgresql://${POSTGRES_USER:-address}:$encoded@${POSTGRES_HOST:-postgres}:5432/${POSTGRES_DB:-address}"
fi

mkdir -p "$ADDRESS_DATA_ROOT/staging" "$SYNC_STATE_DIR" "$HOME" "$XDG_CACHE_HOME" "$PIP_CACHE_DIR"
if [ "${ADDRESS_RUN_AS_ROOT:-false}" = "true" ]; then
  exec "$@"
fi
chown address:address "$ADDRESS_DATA_ROOT" "$(dirname "$SYNC_STATE_DIR")"
chown -R address:address "$ADDRESS_DATA_ROOT/staging" "$SYNC_STATE_DIR" "$HOME" "$XDG_CACHE_HOME" "$PIP_CACHE_DIR"
exec gosu address "$@"
