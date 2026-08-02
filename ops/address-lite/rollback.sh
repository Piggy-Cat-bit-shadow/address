#!/usr/bin/env bash
set -euo pipefail

: "${ROOT:?ROOT is required}"
REQUESTED="${REQUESTED:-previous}"

current_link="$ROOT/current"
test -L "$current_link"
active_release="$(basename "$(readlink "$current_link")")"
[[ "$active_release" =~ ^[0-9a-f]{12}$ ]]

validate_release() {
  local release="$1"
  [[ "$release" =~ ^[0-9a-f]{12}$ ]]
  test -s "$ROOT/releases/$release/index.html"
  test -s "$ROOT/releases/$release/data/countries.json"
  test -s "$ROOT/releases/$release/build-info.json"
}

if [[ "$REQUESTED" == 'previous' ]]; then
  target=''
  while IFS= read -r candidate; do
    if [[ "$candidate" != "$active_release" ]] && validate_release "$candidate"; then
      target="$candidate"
      break
    fi
  done < <(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' \
    | sort -rn | cut -d' ' -f2- | grep -E '^[0-9a-f]{12}$' || true)
  [[ -n "$target" ]] || { echo 'No valid previous Address Lite release is available.' >&2; exit 1; }
else
  target="$REQUESTED"
  validate_release "$target"
  [[ "$target" != "$active_release" ]] || { echo 'Requested release is already active.' >&2; exit 1; }
fi

ln -sfn "releases/$target" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
[[ "$(basename "$(readlink "$ROOT/current")")" == "$target" ]]
printf 'ROLLBACK_RELEASE=%s\n' "$target"
