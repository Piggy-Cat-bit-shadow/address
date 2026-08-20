#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RELEASE_ID=${1:-}
RELEASE_IMAGE=${2:-}
OVERLAY=$ROOT/ops/docker-compose.production.yml
TEMPLATE=$ROOT/ops/caddy/Caddyfile.template
STATE_ROOT=$ROOT/runtime/deploy
GATEWAY_ROOT=$ROOT/runtime/gateway
DRAIN_SECONDS=${ADDRESS_DEPLOY_DRAIN_SECONDS:-30}
RELEASE_RETENTION=${ADDRESS_RELEASE_RETENTION:-5}

if [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
  echo "Release ID is invalid" >&2
  exit 1
fi
if [[ ! "$RELEASE_IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ ]] || [[ "$RELEASE_IMAGE" == *:latest ]]; then
  echo "Release image must be an immutable, non-latest reference" >&2
  exit 1
fi
if [[ ! "$DRAIN_SECONDS" =~ ^[0-9]+$ ]] || (( DRAIN_SECONDS > 600 )); then
  echo "ADDRESS_DEPLOY_DRAIN_SECONDS must be between 0 and 600" >&2
  exit 1
fi
if [[ ! "$RELEASE_RETENTION" =~ ^[0-9]+$ ]] || (( RELEASE_RETENTION < 2 || RELEASE_RETENTION > 20 )); then
  echo "ADDRESS_RELEASE_RETENTION must be between 2 and 20" >&2
  exit 1
fi
if [[ ! -f "$ROOT/docker-compose.yml" || ! -f "$OVERLAY" || ! -f "$TEMPLATE" ]]; then
  echo "Production deployment files are incomplete" >&2
  exit 1
fi
docker image inspect "$RELEASE_IMAGE" >/dev/null

mkdir -p "$STATE_ROOT" "$GATEWAY_ROOT"
exec 9>"$STATE_ROOT/activation.lock"
if ! flock -n 9; then
  echo "Another production activation is already running" >&2
  exit 1
fi
ACTIVE_SLOT=''
if [[ -f "$STATE_ROOT/active-slot" ]]; then
  ACTIVE_SLOT=$(tr -d '\r\n' <"$STATE_ROOT/active-slot")
fi
if [[ "$ACTIVE_SLOT" != blue && "$ACTIVE_SLOT" != green ]]; then
  ACTIVE_SLOT=''
fi
if [[ -z "$ACTIVE_SLOT" && -f "$GATEWAY_ROOT/Caddyfile" ]]; then
  ACTIVE_SLOT=$(sed -n 's/.*api-\(blue\|green\):8787.*/\1/p' "$GATEWAY_ROOT/Caddyfile" | head -n 1)
fi
if [[ "$ACTIVE_SLOT" == blue ]]; then
  TARGET_SLOT=green
else
  TARGET_SLOT=blue
fi

slot_value() {
  local slot=$1 suffix=$2 fallback=$3 file
  file=$STATE_ROOT/$slot.$suffix
  if [[ -s "$file" ]]; then
    tr -d '\r\n' <"$file"
  else
    printf '%s' "$fallback"
  fi
}

ADDRESS_BLUE_IMAGE=$(slot_value blue image "$RELEASE_IMAGE")
ADDRESS_GREEN_IMAGE=$(slot_value green image "$RELEASE_IMAGE")
ADDRESS_BLUE_RELEASE=$(slot_value blue release "$RELEASE_ID")
ADDRESS_GREEN_RELEASE=$(slot_value green release "$RELEASE_ID")
if [[ "$TARGET_SLOT" == blue ]]; then
  ADDRESS_BLUE_IMAGE=$RELEASE_IMAGE
  ADDRESS_BLUE_RELEASE=$RELEASE_ID
else
  ADDRESS_GREEN_IMAGE=$RELEASE_IMAGE
  ADDRESS_GREEN_RELEASE=$RELEASE_ID
fi
ADDRESS_MIGRATION_IMAGE=$RELEASE_IMAGE
ADDRESS_SYNC_IMAGE=$RELEASE_IMAGE
export ADDRESS_BLUE_IMAGE ADDRESS_GREEN_IMAGE ADDRESS_BLUE_RELEASE ADDRESS_GREEN_RELEASE
export ADDRESS_MIGRATION_IMAGE ADDRESS_SYNC_IMAGE

compose() {
  docker compose -f "$ROOT/docker-compose.yml" -f "$OVERLAY" "$@"
}

cleanup_release_artifacts() {
  local releases_root=$ROOT/runtime/releases
  [[ -d "$releases_root" ]] || return 0
  local protected=" $RELEASE_ID " file value index=0 release target
  for file in "$STATE_ROOT"/*.release; do
    [[ -s "$file" ]] || continue
    value=$(tr -d '\r\n' <"$file")
    [[ "$value" =~ ^[A-Za-z0-9._-]{1,128}$ ]] && protected+="$value "
  done
  while IFS= read -r release; do
    [[ "$release" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || continue
    index=$((index + 1))
    if (( index <= RELEASE_RETENTION )) || [[ "$protected" == *" $release "* ]]; then
      continue
    fi
    target=$releases_root/$release
    [[ "$target" == "$ROOT/runtime/releases/"* && -d "$target" && ! -L "$target" ]] || continue
    rm -rf -- "$target"
  done < <(find "$releases_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -nr | cut -d' ' -f2-)
  find "$ROOT/runtime" -mindepth 1 -maxdepth 2 -type f \
    \( -name 'address-*.tar.gz' -o -name '.deploy-*.tar.gz' \) -mtime +1 -delete
}

verify_slot() {
  local service=$1 port=$2 path=$3
  compose exec -T "$service" node -e '
    const [url, expected] = process.argv.slice(1);
    fetch(url).then((response) => {
      if (!response.ok || response.headers.get("x-address-release") !== expected) process.exit(1);
    }).catch(() => process.exit(1));
  ' "http://127.0.0.1:$port$path" "$RELEASE_ID"
}

render_gateway() {
  sed \
    -e "s/__API_UPSTREAM__/api-$TARGET_SLOT:8787/g" \
    -e "s/__BROKER_UPSTREAM__/credential-broker-$TARGET_SLOT:8792/g" \
    "$TEMPLATE" >"$GATEWAY_ROOT/Caddyfile.next"
}

rollback_cutover() {
  local status=$?
  local stop_timeout=30
  trap - ERR INT TERM
  set +e
  if [[ -f "$GATEWAY_ROOT/Caddyfile.previous" ]]; then
    stop_timeout=5700
    cp "$GATEWAY_ROOT/Caddyfile.previous" "$GATEWAY_ROOT/Caddyfile"
    compose exec -T gateway caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  elif [[ "$CUTOVER_STARTED" == true ]]; then
    stop_timeout=5700
    compose stop -t 10 gateway
  fi
  compose --profile "production-$TARGET_SLOT" stop -t "$stop_timeout" \
    "api-$TARGET_SLOT" "credential-broker-$TARGET_SLOT"
  echo "Deployment failed; gateway remains on the previous release" >&2
  exit "$status"
}

CUTOVER_STARTED=false
trap rollback_cutover ERR INT TERM

echo "==> preparing PostgreSQL and migration"
compose up -d --wait --wait-timeout 180 postgres
compose run --rm --no-deps -T migrate

echo "==> starting $TARGET_SLOT release $RELEASE_ID"
compose --profile "production-$TARGET_SLOT" up -d --no-deps --wait --wait-timeout 180 \
  "credential-broker-$TARGET_SLOT"
compose --profile "production-$TARGET_SLOT" up -d --no-deps --wait --wait-timeout 180 \
  "api-$TARGET_SLOT"
verify_slot "credential-broker-$TARGET_SLOT" 8792 /healthz
verify_slot "api-$TARGET_SLOT" 8787 /api/v1/ready

render_gateway
compose run --rm --no-deps -T gateway caddy validate --config /etc/caddy/Caddyfile.next --adapter caddyfile
rm -f "$GATEWAY_ROOT/Caddyfile.previous"
if [[ -f "$GATEWAY_ROOT/Caddyfile" ]]; then
  cp "$GATEWAY_ROOT/Caddyfile" "$GATEWAY_ROOT/Caddyfile.previous"
fi
CUTOVER_STARTED=true
mv "$GATEWAY_ROOT/Caddyfile.next" "$GATEWAY_ROOT/Caddyfile"
if compose ps --status running --services | grep -Fx gateway >/dev/null; then
  compose exec -T gateway caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
else
  compose up -d --no-deps --wait --wait-timeout 180 gateway
fi

headers=$(curl -fsS --max-time 15 -D - -o /dev/null http://127.0.0.1:20022/api/v1/ready)
if ! grep -Fqi "x-address-release: $RELEASE_ID" <<<"$headers"; then
  echo "Gateway release verification failed" >&2
  false
fi

printf '%s\n' "$RELEASE_IMAGE" >"$STATE_ROOT/$TARGET_SLOT.image.next"
printf '%s\n' "$RELEASE_ID" >"$STATE_ROOT/$TARGET_SLOT.release.next"
mv "$STATE_ROOT/$TARGET_SLOT.image.next" "$STATE_ROOT/$TARGET_SLOT.image"
mv "$STATE_ROOT/$TARGET_SLOT.release.next" "$STATE_ROOT/$TARGET_SLOT.release"
printf '%s\n' "$TARGET_SLOT" >"$STATE_ROOT/active-slot.next"
mv "$STATE_ROOT/active-slot.next" "$STATE_ROOT/active-slot"
rm -f "$GATEWAY_ROOT/Caddyfile.previous"
trap - ERR INT TERM

if [[ -n "$ACTIVE_SLOT" ]]; then
  echo "==> draining $ACTIVE_SLOT for ${DRAIN_SECONDS}s"
  sleep "$DRAIN_SECONDS"
  compose --profile "production-$ACTIVE_SLOT" stop -t 5700 \
    "api-$ACTIVE_SLOT" "credential-broker-$ACTIVE_SLOT"
fi

for legacy_service in api credential-broker; do
  if compose ps --status running --services | grep -Fx "$legacy_service" >/dev/null; then
    compose stop -t 30 "$legacy_service"
  fi
done

echo "==> updating singleton sync service"
compose up -d --no-deps --wait --wait-timeout 6000 sync
cleanup_release_artifacts
compose ps
echo "==> active release $RELEASE_ID on $TARGET_SLOT"
