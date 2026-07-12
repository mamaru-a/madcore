# Madcore — one command for the full stack
#
#   make test
#
# Does everything, in order:
#   1. Download/link deltachat-rpc-server → .tools/
#   2. Start madmail Docker (static IP) + enable webimap + websmtp
#   3. Build dist/
#   4. Offline unit tests (test/rpc/)
#   5. SecureJoin live (JS only):
#        core ↔ core  →  madcore ↔ madcore  →  cross both ways
#
# Other targets: test-init, test-unit, test-sj, madmail-up/down

ROOT        := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
TOOLS       := $(ROOT).tools
RPC_SERVER  := $(TOOLS)/deltachat-rpc-server
MADMAIL_URL ?= https://172.28.100.10
export MADMAIL_URL
export NODE_TLS_REJECT_UNAUTHORIZED := 0
export PATH := $(TOOLS):$(PATH)
export DELTACHAT_RPC_SERVER ?= $(RPC_SERVER)

BUN_SJ := NODE_TLS_REJECT_UNAUTHORIZED=0 \
	MADMAIL_URL="$(MADMAIL_URL)" \
	DELTACHAT_RPC_SERVER="$${DELTACHAT_RPC_SERVER:-$(RPC_SERVER)}" \
	PATH="$(TOOLS):$$PATH"

.PHONY: help test test-init test-unit test-sj madmail-up madmail-down \
	build download-core ensure-prereqs clean-tools

help:
	@echo "  make test        FULL pipeline (default — do this)"
	@echo "  make test-init   prereqs only (rpc-server + madmail + build)"
	@echo "  make test-unit   offline unit tests only"
	@echo "  make test-sj     live SecureJoin only (madmail must be up)"
	@echo "  make madmail-up / madmail-down"
	@echo "  make build"

download-core:
	@bash "$(ROOT)test/live/download-rpc-server.sh"

# madmail-docker-up.sh enables webimap + websmtp after HTTPS is ready
madmail-up:
	@bash "$(ROOT)test/live/madmail-docker-up.sh"

madmail-down:
	-docker rm -f madmail-test 2>/dev/null || true

build:
	@cd "$(ROOT)" && bun run build

test-init: download-core madmail-up build
	@echo ""
	@echo "test-init complete."
	@echo "  MADMAIL_URL=$(MADMAIL_URL)"
	@echo "  rpc-server: $$(command -v deltachat-rpc-server 2>/dev/null || echo '$(RPC_SERVER)')"
	@echo "  webimap + websmtp: enabled"

ensure-prereqs: test-init

test-unit:
	@echo ""
	@echo "══ unit tests (test/rpc) ══"
	@cd "$(ROOT)" && bun test test/rpc/

# Live SecureJoin: core first, then madcore (order fixed in the test file)
test-sj:
	@echo ""
	@echo "══ SecureJoin live (core ↔ core, then madcore + cross) ══"
	@echo "  MADMAIL_URL=$(MADMAIL_URL)"
	@cd "$(ROOT)" && $(BUN_SJ) bun test test/live/securejoin-docker.test.ts

# ── Default: everything ──────────────────────────────────────────────
test: ensure-prereqs test-unit test-sj
	@echo ""
	@echo "══════════════════════════════════════════════════"
	@echo " All tests finished."
	@echo "   • unit (test/rpc)"
	@echo "   • core ↔ core   (JS + deltachat-rpc-server)"
	@echo "   • madcore + cross (JS + webimap/websmtp)"
	@echo "══════════════════════════════════════════════════"

clean-tools:
	rm -rf "$(TOOLS)"
