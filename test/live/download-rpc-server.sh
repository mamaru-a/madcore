#!/usr/bin/env bash
# Download a prebuilt deltachat-rpc-server binary into .tools/
# (manylinux wheel from PyPI — no Python runtime required at test time).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${ROOT}/.tools"
OUT="${TOOLS}/deltachat-rpc-server"
VERSION="${DELTACHAT_RPC_VERSION:-2.53.0}"

mkdir -p "$TOOLS"

if [[ -x "$OUT" ]]; then
  # Already present — quick smoke
  if DC_ACCOUNTS_PATH="$(mktemp -d)" "$OUT" </dev/null >/dev/null 2>&1 & then
    sleep 0.2
    kill $! 2>/dev/null || true
  fi
  echo "OK  $OUT (already present)"
  exit 0
fi

# Prefer system binary on PATH
if command -v deltachat-rpc-server >/dev/null 2>&1; then
  SYS="$(command -v deltachat-rpc-server)"
  echo "Linking system binary: $SYS → $OUT"
  ln -sfn "$SYS" "$OUT"
  echo "OK  $OUT"
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  WHEEL_ARCH="manylinux_2_17_x86_64.manylinux2014_x86_64.musllinux_1_1_x86_64" ;;
  aarch64|arm64) WHEEL_ARCH="manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64" ;;
  *)
    echo "Unsupported arch $ARCH — install deltachat-rpc-server manually" >&2
    exit 1
    ;;
esac

# Resolve exact wheel URL from PyPI JSON
echo "Resolving deltachat-rpc-server==${VERSION} wheel for ${ARCH}…"
WHEEL_URL="$(
  curl -fsSL "https://pypi.org/pypi/deltachat-rpc-server/${VERSION}/json" \
    | python3 -c "
import json,sys
j=json.load(sys.stdin)
arch='''${WHEEL_ARCH}'''
for u in j['urls']:
    if u['packagetype']=='bdist_wheel' and arch in u['filename']:
        print(u['url']); break
else:
    sys.exit('no matching wheel')
"
)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading $WHEEL_URL"
curl -fsSL "$WHEEL_URL" -o "$TMP/wheel.whl"
python3 - <<PY
import zipfile, os, stat, shutil
from pathlib import Path
z = zipfile.ZipFile("$TMP/wheel.whl")
# Binary is typically deltachat_rpc_server/deltachat-rpc-server
names = [n for n in z.namelist() if n.rstrip("/").endswith("deltachat-rpc-server") and not n.endswith("/")]
if not names:
    # fallback: any file named that
    names = [n for n in z.namelist() if "deltachat-rpc-server" in n.split("/")[-1] and not n.endswith("/")]
if not names:
    raise SystemExit("binary not found in wheel: " + ", ".join(z.namelist()[:40]))
name = names[0]
print("extract", name)
z.extract(name, "$TMP/extract")
src = Path("$TMP/extract") / name
dst = Path("$OUT")
dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(src, dst)
dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
print("wrote", dst)
PY

echo "OK  $OUT"
DC_ACCOUNTS_PATH="$(mktemp -d)" "$OUT" <<'EOF' | head -c 200 || true
{"jsonrpc":"2.0","method":"get_system_info","params":[],"id":1}
EOF
echo
