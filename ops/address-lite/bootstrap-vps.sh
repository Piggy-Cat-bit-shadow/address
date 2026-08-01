#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/var/www/address}"
OWNER="${2:-${SUDO_USER:-$USER}}"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo/root: sudo bash ops/address-lite/bootstrap-vps.sh [web-root] [owner]" >&2
  exit 1
fi

install -d -m 0755 -o "$OWNER" -g "$OWNER" "$ROOT" "$ROOT/releases"
echo "Address Lite release root ready: $ROOT"
echo "Owner: $OWNER"
echo "Configure the existing Nginx vhost with: root $ROOT/current;"
