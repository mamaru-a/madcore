#!/usr/bin/env bash
# Start madmail for CI e2e (install bootstrap + TLS + WebIMAP/WebSMTP).
# Mirrors test/live/madmail-docker-up.sh but uses loopback URLs for Actions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="${MADMAIL_DATA:-$ROOT/.madmail-e2e-ci}"
NET="${MADMAIL_NET:-madmail-e2e-net}"
IP="${MADMAIL_IP:-172.28.100.10}"
NAME="${MADMAIL_CONTAINER_NAME:-madmail-e2e}"
IMAGE="${MADMAIL_IMAGE:-ghcr.io/themadorg/madmail:latest}"
MADMAIL_SRC="${MADMAIL_SRC:-$ROOT/../madmail}"

if [[ "${MADMAIL_BUILD_LOCAL:-}" == "1" && -f "$MADMAIL_SRC/Dockerfile" ]]; then
  echo "Building local madmail image from $MADMAIL_SRC …"
  docker build -t madmail-e2e:local "$MADMAIL_SRC"
  IMAGE="madmail-e2e:local"
fi

mkdir -p "$DATA"/{lib,etc,run}

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  echo "Creating network $NET (172.28.100.0/24)…"
  docker network create --subnet=172.28.100.0/24 "$NET"
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
echo "Starting $NAME (${IMAGE}) at $IP …"
docker run -d \
  --name "$NAME" \
  --cap-add NET_BIND_SERVICE \
  --network "$NET" \
  --ip "$IP" \
  -p 8080:80 \
  -p 8443:443 \
  -v "$DATA/lib:/var/lib/madmail" \
  -v "$DATA/etc:/etc/madmail:ro" \
  -v "$DATA/run:/run/madmail" \
  "$IMAGE"

echo "Waiting for HTTPS…"
for _ in $(seq 1 60); do
  if curl -skf "https://127.0.0.1:8443/" >/dev/null 2>&1; then
    docker exec "$NAME" madmail webimap enable >/dev/null
    docker exec "$NAME" madmail websmtp enable >/dev/null
    docker exec "$NAME" madmail port imap public >/dev/null 2>&1 || true
    docker exec "$NAME" madmail reload >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      code="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:8443/webimap/mailboxes" || true)"
      if [[ "$code" == "401" ]]; then
        echo "Madmail ready — https://127.0.0.1:8443 (webimap + websmtp enabled)"
        exit 0
      fi
      sleep 1
    done
    echo "WebIMAP probe failed (expected 401, got ${code:-unknown})" >&2
    docker logs "$NAME" 2>&1 | tail -40
    exit 1
  fi
  sleep 1
done

echo "madmail did not become ready on https://127.0.0.1:8443" >&2
docker logs "$NAME" 2>&1 | tail -40
exit 1