#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/compose-root.sh"
export ADDRESS_ROOT="$ROOT"
APP=$REPOSITORY
RUNTIME="$ROOT/runtime"
NODE="$RUNTIME/node/bin/node"

export HOME="$RUNTIME/home"
export npm_config_cache="$RUNTIME/npm-cache"
export PIP_CACHE_DIR="$RUNTIME/pip-cache"
export ADDRESS_DATA_ROOT="${ADDRESS_DATA_ROOT:-$ROOT/data/address}"
export ADDRESS_SYNC_CACHE_DIR="${ADDRESS_SYNC_CACHE_DIR:-$ROOT/data/address/staging}"
export STATIC_ROOT="${STATIC_ROOT:-$APP/dist}"
export SYNC_STATE_DIR="${SYNC_STATE_DIR:-$RUNTIME/sync-control}"
export PYTHON_BIN="${PYTHON_BIN:-$RUNTIME/venv/bin/python}"

if [ -f "$RUNTIME/address.env" ]; then
  set -a
  . "$RUNTIME/address.env"
  set +a
fi

export HOME="$RUNTIME/home"
export npm_config_cache="$RUNTIME/npm-cache"
export PIP_CACHE_DIR="$RUNTIME/pip-cache"
test -n "${POSTGRES_URL:-}" || { echo "POSTGRES_URL is required" >&2; exit 1; }
for path in "$ADDRESS_DATA_ROOT" "$ADDRESS_SYNC_CACHE_DIR" "$STATIC_ROOT" "$SYNC_STATE_DIR" "$PYTHON_BIN"; do
  case "$path" in
    "$ROOT"/*) ;;
    *) echo "Path outside $ROOT: $path" >&2; exit 1 ;;
  esac
done

mkdir -p "$ADDRESS_SYNC_CACHE_DIR" "$ROOT/logs" "$ROOT/backups" "$RUNTIME/home" "$RUNTIME/pids"
test -x "$NODE"
test -d "$APP"
