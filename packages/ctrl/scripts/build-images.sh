#!/usr/bin/env bash
# Build and push Alfred Docker images to GHCR from local alfred-deploy directory.
# Usage: ./scripts/build-images.sh [--push]
set -euo pipefail

DEPLOY_DIR="${ALFRED_DEPLOY_DIR:-$HOME/alfred-deploy}"
REGISTRY="ssdavidai00"
TAG="${IMAGE_TAG:-latest}"
PUSH=false

if [[ "${1:-}" == "--push" ]]; then
  PUSH=true
fi

if [[ ! -d "$DEPLOY_DIR" ]]; then
  echo "ERROR: alfred-deploy directory not found at $DEPLOY_DIR"
  echo "Set ALFRED_DEPLOY_DIR to override."
  exit 1
fi

echo "=== Building Alfred Docker images ==="
echo "Source: $DEPLOY_DIR"
echo "Registry: $REGISTRY"
echo "Tag: $TAG"
echo ""

# Force amd64 — Acme Cloud servers are x86_64, local Mac is ARM
PLATFORM="linux/amd64"

# --- Init container ---
echo "[1/3] Building alfred-init..."
docker build \
  --platform "$PLATFORM" \
  -t "$REGISTRY/alfred-init:$TAG" \
  -f "$DEPLOY_DIR/init/Dockerfile" \
  "$DEPLOY_DIR"
echo "  OK"

# --- OpenClaw gateway ---
echo "[2/3] Building alfred-openclaw..."
docker build \
  --platform "$PLATFORM" \
  -t "$REGISTRY/alfred-openclaw:$TAG" \
  -f "$DEPLOY_DIR/openclaw/Dockerfile" \
  "$DEPLOY_DIR/openclaw"
echo "  OK"

# --- Alfred worker ---
echo "[3/3] Building alfred-worker..."
docker build \
  --platform "$PLATFORM" \
  -t "$REGISTRY/alfred-worker:$TAG" \
  -f "$DEPLOY_DIR/alfred/Dockerfile.deploy" \
  "$DEPLOY_DIR"
echo "  OK"

echo ""
echo "=== All images built ==="
echo "  $REGISTRY/alfred-init:$TAG"
echo "  $REGISTRY/alfred-openclaw:$TAG"
echo "  $REGISTRY/alfred-worker:$TAG"

if $PUSH; then
  echo ""
  echo "=== Pushing to GHCR ==="
  echo "Make sure you're logged in: docker login ghcr.io -u ssdavidai"
  echo ""
  docker push "$REGISTRY/alfred-init:$TAG"
  docker push "$REGISTRY/alfred-openclaw:$TAG"
  docker push "$REGISTRY/alfred-worker:$TAG"
  echo ""
  echo "=== All images pushed ==="
else
  echo ""
  echo "Run with --push to push to GHCR."
  echo "Login first: docker login ghcr.io -u ssdavidai"
fi
