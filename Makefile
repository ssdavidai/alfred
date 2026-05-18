# alfred-black — developer image-build helpers.
#
# NOTE: `docker compose up` never needs these targets — every service in
# docker-compose.yaml references a published image. These targets exist only
# to (re)build and push the custom images. Real targets land via issue #17.

IMAGE_PREFIX ?= ssdavidai00
TAG          ?= dev

.PHONY: help
help:
	@echo "alfred-black — image build helpers (not required for 'docker compose up')"
	@echo "  build targets are defined in issue #17 (Phase 1)"

# Placeholder — replaced by the real CI-aligned build targets in #17:
#   build-hermes build-ctrl-api build-web build-learn build-mcp-server build-init
