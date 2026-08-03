#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

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
curl -fsS "http://127.0.0.1:${API_PORT:-8787}/api/v1/health" || true
