#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
if [ -n "${ADDRESS_ROOT:-}" ]; then
  ROOT=$ADDRESS_ROOT
elif [ "$(basename "$REPOSITORY")" = app ]; then
  ROOT=$(dirname "$REPOSITORY")
else
  ROOT=$REPOSITORY
fi
COMPOSE_FILE=$ROOT/docker-compose.yml
