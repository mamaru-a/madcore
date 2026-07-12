#!/usr/bin/env bash
# Start local madmail with a static Docker IP for SecureJoin interop tests.
#
# Network: madmail-test  172.28.100.0/24
# IP:      172.28.100.10
# HTTPS:   https://172.28.100.10/  (also https://127.0.0.1:8443/)
#
# Usage:
#   ./test/live/madmail-docker-up.sh
#   ./test/live/madmail-docker-up.sh --reinstall   # wipe state + re-run install
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="${MADMAIL_DATA:-$ROOT/.madmail-docker}"
NET="${MADMAIL_NET:-madmail-test}"
IP="${MADMAIL_IP:-172.28.100.10}"
NAME="${MADMAIL_NAME:-madmail-test}"
IMAGE="${MADMAIL_IMAGE:-ghcr.io/themadorg/madmail:latest}"
REINSTALL=0
[[ "${1:-}" == "--reinstall" ]] && REINSTALL=1

mkdir -p "$DATA"/{lib,etc,run}

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  echo "Creating network $NET (172.28.100.0/24)…"
  docker network create --subnet=172.28.100.0/24 "$NET"
fi

if [[ "$REINSTALL" == "1" ]]; then
  echo "Wiping $DATA and reinstalling…"
  docker rm -f "$NAME" 2>/dev/null || true
  rm -rf "$DATA"/lib/* "$DATA"/etc/* "$DATA"/run/*
fi

if [[ ! -f "$DATA/etc/madmail.conf" ]]; then
  echo "Bootstrap install --simple --ip $IP …"
  docker pull "$IMAGE"
  docker run --rm \
    --cap-add NET_BIND_SERVICE \
    --network "$NET" \
    --ip "$IP" \
    -v "$DATA/lib:/var/lib/madmail" \
    -v "$DATA/etc:/etc/madmail" \
    "$IMAGE" \
    install --simple --ip "$IP" --skip-systemd --skip-user
fi

docker rm -f "$NAME" 2>/dev/null || true
echo "Starting $NAME at $IP …"
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --cap-add NET_BIND_SERVICE \
  --network "$NET" \
  --ip "$IP" \
  -p 25:25 \
  -p 8080:80 \
  -p 8443:443 \
  -p 1143:143 \
  -p 1465:465 \
  -p 1587:587 \
  -p 1993:993 \
  -v "$DATA/lib:/var/lib/madmail" \
  -v "$DATA/etc:/etc/madmail:ro" \
  -v "$DATA/run:/run/madmail" \
  "$IMAGE"

echo "Waiting for HTTPS…"
for i in $(seq 1 30); do
  if curl -skf "https://$IP/" >/dev/null 2>&1; then
    # WebIMAP / WebSMTP are disabled by default — required for madcore.
    docker exec "$NAME" madmail webimap enable >/dev/null
    docker exec "$NAME" madmail websmtp enable >/dev/null
    echo "OK  https://$IP/  (webimap + websmtp enabled)"
    echo "OK  https://127.0.0.1:8443/"
    curl -sk -X POST "https://$IP/new" | head -c 160
    echo
    exit 0
  fi
  sleep 1
done
echo "madmail did not become ready" >&2
docker logs "$NAME" 2>&1 | tail -40
exit 1
