#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/compose-root.sh"

if [ -f "$COMPOSE_FILE" ]; then
  production_overlay="$ROOT/ops/docker-compose.production.yml"
  active_slot_file="$ROOT/runtime/deploy/active-slot"
  if [ -f "$production_overlay" ] && [ -s "$active_slot_file" ]; then
    active_slot=$(tr -d '\r\n' <"$active_slot_file")
    case "$active_slot" in blue|green) ;; *) echo "invalid active production slot" >&2; exit 1 ;; esac
    ADDRESS_BLUE_IMAGE=$(cat "$ROOT/runtime/deploy/blue.image" 2>/dev/null || printf '%s' 'address-local:status-placeholder')
    ADDRESS_GREEN_IMAGE=$(cat "$ROOT/runtime/deploy/green.image" 2>/dev/null || printf '%s' 'address-local:status-placeholder')
    ADDRESS_BLUE_RELEASE=$(cat "$ROOT/runtime/deploy/blue.release" 2>/dev/null || printf '%s' 'status-placeholder')
    ADDRESS_GREEN_RELEASE=$(cat "$ROOT/runtime/deploy/green.release" 2>/dev/null || printf '%s' 'status-placeholder')
    export ADDRESS_BLUE_IMAGE ADDRESS_GREEN_IMAGE ADDRESS_BLUE_RELEASE ADDRESS_GREEN_RELEASE
    if [ "$active_slot" = blue ]; then ADDRESS_SYNC_IMAGE=$ADDRESS_BLUE_IMAGE; else ADDRESS_SYNC_IMAGE=$ADDRESS_GREEN_IMAGE; fi
    ADDRESS_MIGRATION_IMAGE=$ADDRESS_SYNC_IMAGE
    export ADDRESS_SYNC_IMAGE ADDRESS_MIGRATION_IMAGE
    docker compose -f "$COMPOSE_FILE" -f "$production_overlay" ps
    curl -fsS --max-time 15 "http://127.0.0.1:20022/api/v1/ready" >/dev/null
    docker compose -f "$COMPOSE_FILE" -f "$production_overlay" exec -T sync node -e \
      "fetch('http://127.0.0.1:8791/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
    exit 0
  fi
  docker compose -f "$COMPOSE_FILE" ps
  docker compose -f "$COMPOSE_FILE" exec -T api node -e \
    "fetch('http://127.0.0.1:8787/api/v1/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
  docker compose -f "$COMPOSE_FILE" exec -T sync node -e \
    "fetch('http://127.0.0.1:8791/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
  exit 0
fi

. "$SCRIPT_DIR/env.sh"

if command -v systemctl >/dev/null 2>&1 && systemctl cat address.service >/dev/null 2>&1; then
  if systemctl is-active --quiet address.service; then
    printf 'supervisor running pid=%s\n' "$(systemctl show address.service --property MainPID --value)"
  else
    printf 'supervisor stopped\n'
  fi
  names='initial-sync'
else
  names='supervisor initial-sync'
fi

for name in $names; do
  pid_file="$RUNTIME/pids/$name.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    printf '%s running pid=%s\n' "$name" "$(cat "$pid_file")"
  else
    printf '%s stopped\n' "$name"
  fi
done
curl -fsS "http://127.0.0.1:${API_PORT:-8787}/api/v1/health"
