# alfred-black — developer image-build helpers.
#
# NOTE: `docker compose up` NEVER needs these targets. Every service in
# docker-compose.yaml references a published image, pulled from a registry.
# These targets exist only to (re)build + push the custom images locally —
# the same images CI builds via .github/workflows/build-*.yml.
#
# Usage:
#   make build-all            build every custom image for the local arch
#   make build-hermes         build a single image
#   make push-all             build + push multi-arch :latest (needs buildx)
#   make TAG=v1 build-web     override the tag (default: dev)

IMAGE_PREFIX ?= ssdavidai00
TAG          ?= dev
PLATFORMS    ?= linux/amd64,linux/arm64

.PHONY: help
help:
	@echo "alfred-black — image build helpers (not required for 'docker compose up')"
	@echo ""
	@echo "  build-all          build all custom images (local arch, tag=$(TAG))"
	@echo "  build-web          build $(IMAGE_PREFIX)/alfred-web"
	@echo "  build-ctrl-api     build $(IMAGE_PREFIX)/alfred-ctrl-api"
	@echo "  build-hermes       build $(IMAGE_PREFIX)/alfred-black-hermes"
	@echo "  build-learn        build $(IMAGE_PREFIX)/alfred-learn"
	@echo "  build-mcp-server   build $(IMAGE_PREFIX)/alfred-mcp-server"
	@echo "  build-init         build $(IMAGE_PREFIX)/alfred-init"
	@echo "  build-setup        build $(IMAGE_PREFIX)/alfred-setup"
	@echo "  push-all           build + push every image multi-arch ($(PLATFORMS))"
	@echo "  config             validate docker-compose.yaml"
	@echo ""
	@echo "  sync-compose-fleet rsync docker-compose.yaml + caddy/* + .env.example"
	@echo "                     to every tenant in FLEET (default: 5 live hosts);"
	@echo "                     same operation as the deploy-compose.yml workflow,"
	@echo "                     for one-shot operator backfill."
	@echo ""
	@echo "  Override: make TAG=v1 IMAGE_PREFIX=myrepo build-web"
	@echo "            make FLEET=\"host1 host2\" sync-compose-fleet"

# ── single-image build targets (local arch) ────────────────────────────────

.PHONY: build-web
build-web:
	cd packages/web && wasp build
	docker build -t $(IMAGE_PREFIX)/alfred-web:$(TAG) packages/web/.wasp/build

.PHONY: build-ctrl-api
build-ctrl-api:
	docker build -f packages/ctrl/Dockerfile -t $(IMAGE_PREFIX)/alfred-ctrl-api:$(TAG) packages/ctrl

.PHONY: build-hermes
build-hermes:
	docker build -f packages/hermes/Dockerfile -t $(IMAGE_PREFIX)/alfred-black-hermes:$(TAG) packages/hermes

.PHONY: build-learn
build-learn:
	docker build -f packages/learn/Dockerfile -t $(IMAGE_PREFIX)/alfred-learn:$(TAG) packages/learn

.PHONY: build-mcp-server
build-mcp-server:
	docker build -f packages/mcp-server/Dockerfile -t $(IMAGE_PREFIX)/alfred-mcp-server:$(TAG) packages/mcp-server

.PHONY: build-init
build-init:
	docker build -f packages/hermes/init/Dockerfile -t $(IMAGE_PREFIX)/alfred-init:$(TAG) .

.PHONY: build-setup
build-setup:
	docker build -f packages/setup/Dockerfile -t $(IMAGE_PREFIX)/alfred-setup:$(TAG) packages/setup

.PHONY: build-all
build-all: build-web build-ctrl-api build-hermes build-learn build-mcp-server build-init build-setup

# ── multi-arch build + push (mirrors CI; needs `docker buildx`) ─────────────

.PHONY: push-all
push-all:
	docker buildx build --platform $(PLATFORMS) --push \
		-t $(IMAGE_PREFIX)/alfred-ctrl-api:$(TAG) -f packages/ctrl/Dockerfile packages/ctrl
	docker buildx build --platform $(PLATFORMS) --push \
		-t $(IMAGE_PREFIX)/alfred-black-hermes:$(TAG) -f packages/hermes/Dockerfile packages/hermes
	docker buildx build --platform $(PLATFORMS) --push \
		-t $(IMAGE_PREFIX)/alfred-learn:$(TAG) -f packages/learn/Dockerfile packages/learn
	docker buildx build --platform $(PLATFORMS) --push \
		-t $(IMAGE_PREFIX)/alfred-mcp-server:$(TAG) -f packages/mcp-server/Dockerfile packages/mcp-server
	docker buildx build --platform $(PLATFORMS) --push \
		-t $(IMAGE_PREFIX)/alfred-init:$(TAG) -f packages/hermes/init/Dockerfile .
	docker buildx build --platform $(PLATFORMS) --push \
		-t $(IMAGE_PREFIX)/alfred-setup:$(TAG) -f packages/setup/Dockerfile packages/setup
	cd packages/web && wasp build
	docker buildx build --platform $(PLATFORMS) --push \
		-t $(IMAGE_PREFIX)/alfred-web:$(TAG) packages/web/.wasp/build

# ── compose validation ─────────────────────────────────────────────────────

.PHONY: config
config:
	docker compose config --quiet && echo "docker-compose.yaml: OK"

# ── one-shot fleet backfill ────────────────────────────────────────────────
#
# `make sync-compose-fleet` mirrors what .github/workflows/deploy-compose.yml
# does for every push to main, but from an operator's laptop. Use it to
# backfill any tenant the workflow couldn't reach (offline, planned downtime)
# or to push a hot-fix without rolling main.
#
# Inputs (override at the CLI):
#   FLEET   space-separated tenant hostnames (default: the 5 live tenants)
#   SSH_KEY private key path  (default: ~/.ssh/alfred-black-verify)
#
# Example:
#   make sync-compose-fleet
#   make FLEET="zsolt.alfred.black" sync-compose-fleet
#   make SSH_KEY=~/.ssh/id_ed25519 sync-compose-fleet

FLEET   ?= home.alfred.black rj.alfred.black joe.alfred.black zsolt.alfred.black miguel.alfred.black
SSH_KEY ?= $(HOME)/.ssh/alfred-black-verify

.PHONY: sync-compose-fleet
sync-compose-fleet:
	@if [ ! -f "$(SSH_KEY)" ]; then \
		echo "ERROR: SSH key not found at $(SSH_KEY)"; \
		echo "       Override with: make SSH_KEY=/path/to/key sync-compose-fleet"; \
		exit 1; \
	fi
	@docker compose config --quiet >/dev/null
	@SHA=$$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%dT%H%M%SZ); \
	SSH_OPTS="-i $(SSH_KEY) -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"; \
	for host in $(FLEET); do \
		echo ""; \
		echo "── $${host} ──"; \
		if ! ssh $$SSH_OPTS -o BatchMode=yes "root@$${host}" 'echo ok' >/dev/null 2>&1; then \
			echo "  SKIP: unreachable"; \
			continue; \
		fi; \
		ssh $$SSH_OPTS "root@$${host}" "\
			set -e; \
			ts=\$$(date -u +%Y%m%dT%H%M%SZ); \
			for f in docker-compose.yaml caddy/Caddyfile caddy/plane-proxy.Caddyfile .env.example; do \
				if [ -f /opt/alfred/\$${f} ]; then \
					cp -a /opt/alfred/\$${f} /opt/alfred/\$${f}.bak-$${SHA}-\$${ts}; \
				fi; \
			done"; \
		scp -p $$SSH_OPTS docker-compose.yaml "root@$${host}:/opt/alfred/docker-compose.yaml"; \
		scp -p $$SSH_OPTS caddy/Caddyfile "root@$${host}:/opt/alfred/caddy/Caddyfile"; \
		scp -p $$SSH_OPTS caddy/plane-proxy.Caddyfile "root@$${host}:/opt/alfred/caddy/plane-proxy.Caddyfile"; \
		scp -p $$SSH_OPTS .env.example "root@$${host}:/opt/alfred/.env.example"; \
		ssh $$SSH_OPTS "root@$${host}" 'cd /opt/alfred && docker compose -p alfred-black config --quiet && docker compose -p alfred-black up -d'; \
		ssh $$SSH_OPTS "root@$${host}" 'cd /opt/alfred && (docker compose -p alfred-black exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null || docker compose -p alfred-black restart caddy)'; \
		echo "  OK: $${host}"; \
	done
