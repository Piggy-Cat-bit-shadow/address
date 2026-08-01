#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: sudo bash ops/address-lite/bootstrap-vps.sh <web-root> <owner>" >&2
  echo "Example: sudo bash ops/address-lite/bootstrap-vps.sh /path/to/static-site deploy-user" >&2
}

if [[ $# -ne 2 || -z "$1" || -z "$2" ]]; then
  usage
  exit 64
fi

ROOT="$1"
OWNER="$2"

if [[ $EUID -ne 0 ]]; then
  usage
  echo "Root privileges are required only for this one-time directory setup." >&2
  exit 1
fi

install -d -m 0755 -o "$OWNER" -g "$OWNER" "$ROOT" "$ROOT/releases"
echo "Address Lite release root ready: $ROOT"
echo "Owner: $OWNER"
