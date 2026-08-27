#!/bin/sh
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/compose-root.sh"
docker compose -f "$COMPOSE_FILE" run --rm --no-deps bootstrap
printf 'Compose bootstrap is ready in %s\n' "$ROOT"
printf 'Start with: docker compose -f %s up -d\n' "$COMPOSE_FILE"
