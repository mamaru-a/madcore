#!/usr/bin/env bash
# Stop madmail started by madmail-binary-up.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="${MADMAIL_DATA:-$ROOT/.madmail-binary}"
PID_FILE="${DATA}/madmail.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No pid file at $PID_FILE (nothing to stop)"
  exit 0
fi

pid="$(cat "$PID_FILE" || true)"
if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null || true
  # graceful wait
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
  echo "Stopped madmail pid=$pid"
else
  echo "madmail not running (stale pid file)"
fi
rm -f "$PID_FILE"
