#!/usr/bin/env bash
# Start madmail for local/CI e2e tests and enable WebIMAP + WebSMTP.
set -euo pipefail

IMAGE="${MADMAIL_IMAGE:-ghcr.io/themadorg/madmail:latest}"
NAME="${MADMAIL_CONTAINER_NAME:-madmail-e2e}"
HOSTNAME="${MADDY_HOSTNAME:-mail.ci.local}"
DOMAIN="${MADDY_DOMAIN:-ci.local}"
PORT="${MADMAIL_PORT:-8080}"
CONFIG="${MADMAIL_CONFIG:-/etc/madmail/madmail.conf}"
LIBEXEC="${MADMAIL_LIBEXEC:-/var/lib/madmail}"
MADMAIL_BIN="${MADMAIL_BIN:-/bin/madmail}"

echo "Starting madmail (${IMAGE}) on port ${PORT}…"

docker rm -f "$NAME" 2>/dev/null || true

docker run -d \
  --name "$NAME" \
  -e "MADDY_HOSTNAME=${HOSTNAME}" \
  -e "MADDY_DOMAIN=${DOMAIN}" \
  -p "${PORT}:8080" \
  "$IMAGE" \
  run --libexec "$LIBEXEC"

echo "Waiting for madmail HTTP…"
ready=0
for _ in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || true)"
  if [[ "$code" != "000" ]]; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "madmail did not become reachable on port ${PORT}"
  docker logs "$NAME" || true
  exit 1
fi

echo "Enabling WebIMAP and WebSMTP…"
docker exec "$NAME" "$MADMAIL_BIN" --config "$CONFIG" webimap enable --libexec "$LIBEXEC"
docker exec "$NAME" "$MADMAIL_BIN" --config "$CONFIG" websmtp enable --libexec "$LIBEXEC"
docker exec "$NAME" "$MADMAIL_BIN" --config "$CONFIG" reload --libexec "$LIBEXEC"

for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/webimap/mailboxes" || true)"
  if [[ "$code" == "401" ]]; then
    echo "Madmail ready — WebIMAP enabled (http://127.0.0.1:${PORT})"
    exit 0
  fi
  sleep 1
done

echo "WebIMAP probe failed (expected 401, got ${code:-unknown})"
docker logs "$NAME" || true
exit 1