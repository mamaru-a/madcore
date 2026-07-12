#!/usr/bin/env bash
set -euo pipefail
NAME="${MADMAIL_CONTAINER_NAME:-madmail-e2e}"
docker rm -f "$NAME" 2>/dev/null || true