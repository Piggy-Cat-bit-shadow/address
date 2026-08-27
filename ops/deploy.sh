#!/usr/bin/env bash
# Deploy the current non-ignored worktree as an immutable Docker Compose release.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEPLOY_ENV=${ADDRESS_DEPLOY_ENV:-$REPO_ROOT/.deploy.env}
if [[ -f "$DEPLOY_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
  set +a
fi

: "${DEPLOY_HOST:?Set DEPLOY_HOST or create .deploy.env from ops/deploy.env.example}"
DEPLOY_PORT=${DEPLOY_PORT:-22}
DEPLOY_USER=${DEPLOY_USER:-root}
: "${DEPLOY_KEY:?Set DEPLOY_KEY to the SSH private-key path}"
ADDRESS_ROOT=${ADDRESS_ROOT:-/root/address}

case "$DEPLOY_PORT" in
  ''|*[!0-9]*) echo "DEPLOY_PORT must be numeric" >&2; exit 1 ;;
esac
if (( DEPLOY_PORT < 1 || DEPLOY_PORT > 65535 )); then
  echo "DEPLOY_PORT must be between 1 and 65535" >&2
  exit 1
fi
if [[ ! "$DEPLOY_HOST" =~ ^[A-Za-z0-9._:-]+$ ]] || [[ ! "$DEPLOY_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "DEPLOY_HOST or DEPLOY_USER contains unsupported characters" >&2
  exit 1
fi
if [[ ! "$ADDRESS_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "ADDRESS_ROOT must be a safe absolute path" >&2
  exit 1
fi

KEY=${DEPLOY_KEY/#\~/$HOME}
if [[ ! -f "$KEY" ]]; then
  echo "DEPLOY_KEY does not point to a file" >&2
  exit 1
fi

RESTART=true
for arg in "$@"; do
  case "$arg" in
    --dist) ;;
    --no-restart) RESTART=false ;;
    *) echo "Unsupported argument: $arg" >&2; exit 1 ;;
  esac
done

REMOTE=$DEPLOY_USER@$DEPLOY_HOST
RUNTIME=$ADDRESS_ROOT/runtime
SSH_OPTIONS=(
  -o BatchMode=yes
  -o PreferredAuthentications=publickey
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o GSSAPIAuthentication=no
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
)
STAGE=$(mktemp -d)
TARBALL=''
cleanup() {
  rm -rf "$STAGE"
  [[ -z "$TARBALL" ]] || rm -f "$TARBALL"
}
trap cleanup EXIT

cd "$REPO_ROOT"
git ls-files -co --exclude-standard -z \
  | while IFS= read -r -d '' file; do
      [[ -f "$file" || -L "$file" ]] && printf '%s\0' "$file"
    done \
  | tar --null -T - -cf - \
  | tar -xf - -C "$STAGE"
(
  cd "$STAGE"
  find . -type f \
    ! -path './.github/*' \
    ! -name '.env.example' \
    ! -name '.release-manifest.sha256' \
    ! -name '.image-manifest.sha256' \
    -print0 \
    | sort -z \
    | xargs -0 sha256sum > .image-manifest.sha256
  find . -type f ! -name '.release-manifest.sha256' -print0 \
    | sort -z \
    | xargs -0 sha256sum > .release-manifest.sha256
)
TREE_HASH=$(sha256sum "$STAGE/.release-manifest.sha256" | cut -c1-12)
REL="$(git rev-parse --short HEAD)-$TREE_HASH"
TARBALL=$(mktemp "${TMPDIR:-/tmp}/address-$REL.XXXXXX.tar.gz")
tar -C "$STAGE" -czf "$TARBALL" .

scp_retry() {
  for i in 1 2 3 4 5; do
    scp -i "$KEY" -P "$DEPLOY_PORT" "${SSH_OPTIONS[@]}" "$@" && return 0
    echo "scp retry $i"; sleep 30
  done
  return 1
}
ssh_retry() {
  for i in 1 2 3 4 5; do
    ssh -i "$KEY" -p "$DEPLOY_PORT" "${SSH_OPTIONS[@]}" "$REMOTE" "$@" </dev/null && return 0
    echo "ssh retry $i"; sleep 30
  done
  return 1
}

ssh_once() {
  ssh -i "$KEY" -p "$DEPLOY_PORT" "${SSH_OPTIONS[@]}" "$REMOTE" "$@" </dev/null
}

echo "==> uploading $REL"
ssh_retry "mkdir -p '$RUNTIME/releases/$REL'"
scp_retry "$TARBALL" "$REMOTE:$RUNTIME/address-$REL.tar.gz"
ssh_retry "tar -xzf '$RUNTIME/address-$REL.tar.gz' -C '$RUNTIME/releases/$REL' && rm -f '$RUNTIME/address-$REL.tar.gz'"
ssh_retry "cd '$RUNTIME/releases/$REL' && sha256sum --quiet -c .release-manifest.sha256"
ssh_retry "tar -C '$RUNTIME/releases/$REL' -cf - . | tar -C '$ADDRESS_ROOT' -xf - && printf '%s\n' '$REL' > '$ADDRESS_ROOT/RELEASE'"

if $RESTART; then
  IMAGE="address-local:$REL"
  echo "==> building $IMAGE"
  ssh_retry "docker build -t '$IMAGE' '$RUNTIME/releases/$REL'"
  ssh_retry "docker run --rm --entrypoint sh '$IMAGE' -c 'cd /srv/address/app && sha256sum --quiet -c .image-manifest.sha256'"
  ssh_once "cd '$ADDRESS_ROOT' && bash ./ops/activate-production-release.sh '$REL' '$IMAGE'"
else
  echo "==> files synchronized without rebuilding services"
fi

echo "==> deployed $REL"
