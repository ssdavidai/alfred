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
	@echo "  push-all           build + push every image multi-arch ($(PLATFORMS))"
	@echo "  config             validate docker-compose.yaml"
	@echo "  config-vexa        validate docker-compose.yaml with the vexa profile"
	@echo ""
	@echo "  Override: make TAG=v1 IMAGE_PREFIX=myrepo build-web"

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

.PHONY: build-all
build-all: build-web build-ctrl-api build-hermes build-learn build-mcp-server build-init

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
	cd packages/web && wasp build
	docker buildx build --platform $(PLATFORMS) --push \
		-t $(IMAGE_PREFIX)/alfred-web:$(TAG) packages/web/.wasp/build

# ── compose validation ─────────────────────────────────────────────────────

.PHONY: config
config:
	docker compose config --quiet && echo "docker-compose.yaml: OK"

.PHONY: config-vexa
config-vexa:
	docker compose --profile vexa config --quiet && echo "docker-compose.yaml (+vexa): OK"
