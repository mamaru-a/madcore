# Madcore — one command for the full stack
#
#   make test          Local: Docker madmail + core binary + unit + SecureJoin
#   make test-ci       CI:    madmail binary + core binary + unit + SecureJoin
#
# Other targets: test-init, test-unit, test-sj, madmail-up/down, madmail-binary-up/down

ROOT        := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
TOOLS       := $(ROOT).tools
RPC_SERVER  := $(TOOLS)/deltachat-rpc-server
MADMAIL_BIN := $(TOOLS)/madmail

# Docker path (local): fixed bridge IP
MADMAIL_URL_DOCKER ?= https://172.28.100.10
# Binary path (CI): loopback HTTPS on unprivileged port
MADMAIL_URL_BINARY ?= https://127.0.0.1:8443

# Default for local `make test` is Docker URL; `make test-ci` overrides.
MADMAIL_URL ?= $(MADMAIL_URL_DOCKER)
export MADMAIL_URL
export NODE_TLS_REJECT_UNAUTHORIZED := 0
export PATH := $(TOOLS):$(PATH)
export DELTACHAT_RPC_SERVER ?= $(RPC_SERVER)

BUN_SJ := NODE_TLS_REJECT_UNAUTHORIZED=0 \
	MADMAIL_URL="$(MADMAIL_URL)" \
	DELTACHAT_RPC_SERVER="$${DELTACHAT_RPC_SERVER:-$(RPC_SERVER)}" \
	PATH="$(TOOLS):$$PATH"

.PHONY: help test test-ci test-init test-init-ci test-unit test-sj \
	madmail-up madmail-down madmail-binary-up madmail-binary-down \
	build download-core download-madmail ensure-prereqs ensure-prereqs-ci \
	clean-tools

help:
	@echo "  make test              FULL local pipeline (Docker madmail + core binary)"
	@echo "  make test-ci           FULL CI pipeline (madmail binary + core binary)"
	@echo "  make test-init         prereqs only (Docker madmail)"
	@echo "  make test-init-ci      prereqs only (madmail binary)"
	@echo "  make test-unit         offline unit tests only"
	@echo "  make test-sj           live SecureJoin only (madmail must be up)"
	@echo "  make madmail-up / madmail-down           Docker"
	@echo "  make madmail-binary-up / madmail-binary-down   binary"
	@echo "  make download-core / download-madmail"
	@echo "  make build"

download-core:
	@bash "$(ROOT)test/live/download-rpc-server.sh"

download-madmail:
	@bash "$(ROOT)test/live/download-madmail.sh"

# madmail-docker-up.sh enables webimap + websmtp after HTTPS is ready
madmail-up:
	@bash "$(ROOT)test/live/madmail-docker-up.sh"

madmail-down:
	-docker rm -f madmail-test 2>/dev/null || true

madmail-binary-up:
	@bash "$(ROOT)test/live/madmail-binary-up.sh"

madmail-binary-down:
	@bash "$(ROOT)test/live/madmail-binary-down.sh"

build:
	@cd "$(ROOT)" && bun run build

test-init: download-core madmail-up build
	@echo ""
	@echo "test-init complete."
	@echo "  MADMAIL_URL=$(MADMAIL_URL)"
	@echo "  rpc-server: $$(command -v deltachat-rpc-server 2>/dev/null || echo '$(RPC_SERVER)')"
	@echo "  webimap + websmtp: enabled (Docker)"

test-init-ci: download-core download-madmail
	@$(MAKE) madmail-binary-up MADMAIL_URL="$(MADMAIL_URL_BINARY)"
	@$(MAKE) build
	@echo ""
	@echo "test-init-ci complete."
	@echo "  MADMAIL_URL=$(MADMAIL_URL_BINARY)"
	@echo "  madmail: $(MADMAIL_BIN)"
	@echo "  rpc-server: $(RPC_SERVER)"
	@echo "  webimap + websmtp: enabled (binary)"

ensure-prereqs: test-init
ensure-prereqs-ci: test-init-ci

test-unit:
	@echo ""
	@echo "══ unit tests (test/rpc) ══"
	@cd "$(ROOT)" && bun test test/rpc/

# Live SecureJoin + messaging (declaration order fixed in the test files)
test-sj:
	@echo ""
	@echo "══ SecureJoin live (core ↔ core, then madcore + cross) ══"
	@echo "  MADMAIL_URL=$(MADMAIL_URL)"
	@cd "$(ROOT)" && $(BUN_SJ) bun test test/live/securejoin-docker.test.ts
	@echo ""
	@echo "══ Messaging live (send/recv decrypted text) ══"
	@cd "$(ROOT)" && $(BUN_SJ) bun test test/live/messaging-docker.test.ts

# ── Local default: Docker madmail ───────────────────────────────────────
test: ensure-prereqs test-unit test-sj
	@echo ""
	@echo "══════════════════════════════════════════════════"
	@echo " All tests finished (local / Docker madmail)."
	@echo "   • unit (test/rpc)"
	@echo "   • SecureJoin  (core ↔ core, madcore, cross)"
	@echo "   • Messaging   (send/recv decrypted text)"
	@echo "══════════════════════════════════════════════════"

# ── CI: madmail binary + core binary (no long-running Docker service) ───
# Downloads binaries, runs madmail in-process, unit + SecureJoin, then stops.
test-ci:
	@echo "══ CI pipeline: madmail binary + deltachat-rpc-server binary ══"
	@$(MAKE) download-core
	@$(MAKE) download-madmail
	@# Ensure a clean binary instance for this run
	-@bash "$(ROOT)test/live/madmail-binary-down.sh" 2>/dev/null || true
	@MADMAIL_REINSTALL=1 MADMAIL_URL="$(MADMAIL_URL_BINARY)" \
		bash "$(ROOT)test/live/madmail-binary-up.sh"
	@$(MAKE) build
	@$(MAKE) test-unit
	@$(MAKE) test-sj MADMAIL_URL="$(MADMAIL_URL_BINARY)"
	@bash "$(ROOT)test/live/madmail-binary-down.sh"
	@echo ""
	@echo "══════════════════════════════════════════════════"
	@echo " All CI tests finished (binary madmail + core)."
	@echo "   • unit (test/rpc)"
	@echo "   • SecureJoin  (core ↔ core, madcore, cross)"
	@echo "   • Messaging   (send/recv decrypted text)"
	@echo "══════════════════════════════════════════════════"

clean-tools:
	rm -rf "$(TOOLS)"
