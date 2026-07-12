#!/usr/bin/env bash
# Start madmail from the local binary (.tools/madmail) for CI / no-Docker runs.
#
# Uses unprivileged high ports by default so no root is required:
#   HTTPS  https://127.0.0.1:8443
#   HTTP   http://127.0.0.1:8080
#   IMAP   8993 / 8143
#   SMTP   8025 / submission 8465 / 8587
#
# Env:
#   MADMAIL_BIN       path to binary (default: .tools/madmail)
#   MADMAIL_DATA      state dir (default: .madmail-binary)
#   MADMAIL_IP        identity IP (default: 127.0.0.1)
#   MADMAIL_URL       advertised URL (default: https://127.0.0.1:8443)
#   MADMAIL_PRIV_PORTS=1  keep ports 25/80/443/… (needs CAP_NET_BIND_SERVICE or root)
#   MADMAIL_REINSTALL=1   wipe state and re-run install
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${ROOT}/.tools"
BIN="${MADMAIL_BIN:-$TOOLS/madmail}"
DATA="${MADMAIL_DATA:-$ROOT/.madmail-binary}"
IP="${MADMAIL_IP:-127.0.0.1}"
URL="${MADMAIL_URL:-https://127.0.0.1:8443}"
PID_FILE="${DATA}/madmail.pid"
LOG_FILE="${DATA}/madmail.log"
CONF="${DATA}/etc/madmail.conf"

if [[ ! -x "$BIN" ]]; then
  echo "madmail binary not found at $BIN — run test/live/download-madmail.sh first" >&2
  exit 1
fi

mkdir -p "$DATA"/{etc,lib,run}

if [[ "${MADMAIL_REINSTALL:-0}" == "1" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  rm -rf "$DATA"/lib/* "$DATA"/etc/* "$DATA"/run/*
  mkdir -p "$DATA"/{etc,lib,run}
fi

# Stop previous instance from this data dir
if [[ -f "$PID_FILE" ]]; then
  old="$(cat "$PID_FILE" || true)"
  if [[ -n "${old:-}" ]] && kill -0 "$old" 2>/dev/null; then
    # Already running — check HTTPS
    if curl -skf --max-time 3 "$URL/" >/dev/null 2>&1; then
      "$BIN" webimap enable --config "$CONF" --state-dir "$DATA/lib" >/dev/null 2>&1 || true
      "$BIN" websmtp enable --config "$CONF" --state-dir "$DATA/lib" >/dev/null 2>&1 || true
      echo "OK  madmail already running (pid=$old)  $URL"
      exit 0
    fi
    kill "$old" 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

if [[ ! -f "$CONF" ]]; then
  echo "Installing madmail (self-signed, ip=$IP) → $DATA …"
  # install may fail at the end writing man pages under /usr (non-root); conf is still written.
  set +e
  "$BIN" install --simple --ip "$IP" --skip-systemd --skip-user \
    --config-dir "$DATA/etc" --state-dir "$DATA/lib" 2>&1
  inst_rc=$?
  set -e
  if [[ ! -f "$CONF" ]]; then
    echo "madmail install failed (exit $inst_rc) and no conf written" >&2
    exit 1
  fi
  # Point runtime_dir at our writable tree
  if grep -q 'runtime_dir /run/madmail' "$CONF" 2>/dev/null; then
    sed -i "s|runtime_dir /run/madmail|runtime_dir $DATA/run|" "$CONF"
  fi
  # Unprivileged high ports (skip when MADMAIL_PRIV_PORTS=1)
  if [[ "${MADMAIL_PRIV_PORTS:-0}" != "1" ]]; then
    python3 - "$CONF" <<'PY'
import re, sys
from pathlib import Path
p = Path(sys.argv[1])
t = p.read_text()
pairs = [
    (r"tcp://0\.0\.0\.0:25\b", "tcp://0.0.0.0:8025"),
    (r"tls://0\.0\.0\.0:465\b", "tls://0.0.0.0:8465"),
    (r"tcp://0\.0\.0\.0:587\b", "tcp://0.0.0.0:8587"),
    (r"tls://0\.0\.0\.0:993\b", "tls://0.0.0.0:8993"),
    (r"tcp://0\.0\.0\.0:143\b", "tcp://0.0.0.0:8143"),
    (r"tcp://0\.0\.0\.0:80\b", "tcp://0.0.0.0:8080"),
    (r"tls://0\.0\.0\.0:443\b", "tls://0.0.0.0:8443"),
    (r"udp://0\.0\.0\.0:3478\b", "udp://0.0.0.0:13478"),
    (r"tcp://0\.0\.0\.0:3478\b", "tcp://0.0.0.0:13478"),
    (r"turn_port 3478\b", "turn_port 13478"),
]
for a, b in pairs:
    t = re.sub(a, b, t)
p.write_text(t)
print("remapped listeners to unprivileged ports")
PY
  fi
fi

echo "Starting madmail binary ($("$BIN" version 2>/dev/null | head -1 || echo '?')) …"
"$BIN" run --config "$CONF" --state-dir "$DATA/lib" >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
pid="$(cat "$PID_FILE")"

echo "Waiting for $URL …"
for i in $(seq 1 60); do
  if curl -skf --max-time 2 "$URL/" >/dev/null 2>&1; then
    "$BIN" webimap enable --config "$CONF" --state-dir "$DATA/lib" >/dev/null
    "$BIN" websmtp enable --config "$CONF" --state-dir "$DATA/lib" >/dev/null
    echo "OK  $URL  (pid=$pid, webimap + websmtp enabled)"
    curl -sk -X POST "${URL%/}/new" | head -c 160 || true
    echo
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "madmail exited early — log:" >&2
    tail -50 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 0.5
done

echo "madmail did not become ready at $URL" >&2
tail -50 "$LOG_FILE" >&2 || true
exit 1
