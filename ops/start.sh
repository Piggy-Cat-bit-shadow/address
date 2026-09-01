#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/compose-root.sh"

if [ -f "$COMPOSE_FILE" ]; then
  docker compose -f "$COMPOSE_FILE" up -d
  exit 0
fi

. "$SCRIPT_DIR/env.sh"

if command -v systemctl >/dev/null 2>&1 && systemctl cat address.service >/dev/null 2>&1; then
  systemctl start address.service
  exit 0
fi

pid_file="$RUNTIME/pids/supervisor.pid"
if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  exit 0
fi
cd "$APP"
nohup "$NODE" "$APP/ops/supervisor.mjs" >>"$ROOT/logs/supervisor.log" 2>&1 &
echo $! >"$pid_file"
