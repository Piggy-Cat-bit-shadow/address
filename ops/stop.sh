#!/bin/sh
set -eu
. /root/address/app/ops/env.sh

if command -v systemctl >/dev/null 2>&1 && systemctl cat address.service >/dev/null 2>&1; then
  systemctl stop address.service
  exit 0
fi

pid_file="$RUNTIME/pids/supervisor.pid"
[ -f "$pid_file" ] || exit 0
pid=$(cat "$pid_file")
if [ -r "/proc/$pid/cmdline" ] && tr '\000' ' ' <"/proc/$pid/cmdline" | grep -F "$APP/ops/supervisor.mjs" >/dev/null; then
  kill "$pid"
  count=0
  while kill -0 "$pid" 2>/dev/null && [ "$count" -lt 25 ]; do
    sleep 1
    count=$((count + 1))
  done
fi
rm -f "$pid_file"
