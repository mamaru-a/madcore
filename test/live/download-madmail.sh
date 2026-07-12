#!/usr/bin/env bash
# Download a madmail server binary into .tools/madmail (no long-running Docker).
#
# Preference order:
#   1. Existing .tools/madmail (unless FORCE_MADMAIL_DOWNLOAD=1)
#   2. MADMAIL_BIN env path
#   3. Extract from ghcr.io/themadorg/madmail image (matches local Docker tests)
#   4. GitHub release asset madmail-linux-{amd64,arm64}
#
# Env:
#   MADMAIL_VERSION   image tag or release tag (default: latest / v2.9.0 for GH)
#   MADMAIL_IMAGE     container image (default: ghcr.io/themadorg/madmail:latest)
#   FORCE_MADMAIL_DOWNLOAD=1  re-download even if present
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${ROOT}/.tools"
OUT="${TOOLS}/madmail"
IMAGE="${MADMAIL_IMAGE:-ghcr.io/themadorg/madmail:latest}"
GH_VERSION="${MADMAIL_VERSION:-}"

mkdir -p "$TOOLS"

if [[ -x "$OUT" && "${FORCE_MADMAIL_DOWNLOAD:-0}" != "1" ]]; then
  echo "OK  $OUT (already present)  ($("$OUT" version 2>/dev/null | head -1 || echo '?'))"
  exit 0
fi

if [[ -n "${MADMAIL_BIN:-}" && -x "${MADMAIL_BIN}" ]]; then
  cp -f "$MADMAIL_BIN" "$OUT"
  chmod +x "$OUT"
  echo "OK  $OUT (from MADMAIL_BIN=$MADMAIL_BIN)"
  exit 0
fi

# ── 1) Extract from container image (preferred: tracks Docker-tested version) ──
if command -v docker >/dev/null 2>&1; then
  echo "Pulling $IMAGE …"
  docker pull "$IMAGE" >/dev/null
  cid="$(docker create "$IMAGE")"
  cleanup() { docker rm -f "$cid" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  # Common locations in madmail images
  for p in /usr/local/bin/madmail /bin/madmail /usr/bin/madmail /madmail; do
    if docker cp "$cid:$p" "$OUT" 2>/dev/null; then
      chmod +x "$OUT"
      trap - EXIT
      cleanup
      echo "OK  $OUT (from $IMAGE:$p)  ($("$OUT" version 2>/dev/null | head -1 || true))"
      exit 0
    fi
  done
  trap - EXIT
  cleanup
  echo "warn: could not extract madmail from $IMAGE — falling back to GitHub release" >&2
fi

# ── 2) GitHub release binary ─────────────────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ASSET_ARCH="amd64" ;;
  aarch64|arm64) ASSET_ARCH="arm64" ;;
  *)
    echo "Unsupported arch $ARCH — set MADMAIL_BIN to a madmail binary" >&2
    exit 1
    ;;
esac

if [[ -z "$GH_VERSION" ]]; then
  # Resolve latest release tag
  GH_VERSION="$(
    curl -fsSL "https://api.github.com/repos/themadorg/madmail/releases/latest" \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])"
  )"
fi
# Allow both "v2.9.0" and "2.9.0"
TAG="$GH_VERSION"
[[ "$TAG" == v* ]] || TAG="v$TAG"

URL="https://github.com/themadorg/madmail/releases/download/${TAG}/madmail-linux-${ASSET_ARCH}"
echo "Downloading $URL …"
curl -fsSL "$URL" -o "$OUT"
chmod +x "$OUT"
echo "OK  $OUT (GitHub ${TAG})  ($("$OUT" version 2>/dev/null | head -1 || true))"
