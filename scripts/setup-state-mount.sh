#!/usr/bin/env bash
# OPS-PERSIST-1 — one-shot setup for the /opt/alfred/state host bind that
# persists ctrl-api's state.db across container restarts.
#
# Background: ctrl-api's state.db lives at /var/lib/alfred/state.db inside
# the container. Without a host bind, every `docker compose up --force-recreate
# ctrl-api` wipes the file — losing accumulated audit rows and triggering an
# 11.7s vault_index repopulation scan on the next boot.
#
# This script:
#   1. creates /opt/alfred/state on the host (uid 0, 0700) — ctrl-api runs
#      as root inside the container (no `user:` directive in compose), so
#      the mount must be writable by root. uid 1000 would block writes.
#   2. patches /opt/alfred/compose/docker-compose.yaml to add the bind mount
#      to the ctrl-api volumes list (idempotent — re-runs are a no-op if the
#      line is already present)
#   3. recreates ctrl-api so the new mount takes effect
#
# Usage (run on the tenant host as deploy or root):
#   sudo bash setup-state-mount.sh
#
# Cloud-init (cloud-init.yaml.njk) and the compose template
# (docker-compose.yaml.njk) already cover fresh provisions; this script
# exists solely to retrofit the four tenants live at the time of OPS-PERSIST-1
# (raj313 / miguel / rapali / david).

set -euo pipefail

STATE_DIR=/opt/alfred/state
COMPOSE_FILE=/opt/alfred/compose/docker-compose.yaml
MOUNT_LINE="      - /opt/alfred/state:/var/lib/alfred"
# Anchor: the very next line under ctrl-api's existing /opt/alfred bind, which
# is unique to the ctrl-api block. Using a unique anchor keeps the sed insert
# idempotent and avoids affecting other services.
ANCHOR_LINE="      - /opt/alfred/compose:/opt/alfred/compose"

if [[ $EUID -ne 0 ]]; then
    echo "error: must run as root (use sudo)" >&2
    exit 1
fi

# 1. Host directory
if [[ ! -d "$STATE_DIR" ]]; then
    mkdir -p "$STATE_DIR"
    echo "[setup-state-mount] created $STATE_DIR"
else
    echo "[setup-state-mount] $STATE_DIR already exists"
fi
chown 0:0 "$STATE_DIR"
chmod 700 "$STATE_DIR"
echo "[setup-state-mount] $STATE_DIR owned by 0:0 mode 0700"

# 2. Compose patch
if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "error: $COMPOSE_FILE missing — is this an Alfred tenant?" >&2
    exit 1
fi

if grep -qF "$MOUNT_LINE" "$COMPOSE_FILE"; then
    echo "[setup-state-mount] bind mount already present in $COMPOSE_FILE"
else
    # Insert after the unique ctrl-api anchor line.
    if ! grep -qF "$ANCHOR_LINE" "$COMPOSE_FILE"; then
        echo "error: anchor line not found in $COMPOSE_FILE; refusing to patch blindly" >&2
        exit 1
    fi
    # Use awk to insert after the FIRST match of the anchor only (the anchor
    # line happens to be unique to ctrl-api, but `1; /anchor/ && !done` is
    # a defensive belt+suspenders pattern).
    awk -v anchor="$ANCHOR_LINE" -v ins="$MOUNT_LINE" '
        { print }
        $0 == anchor && !done { print ins; done=1 }
    ' "$COMPOSE_FILE" > "$COMPOSE_FILE.tmp"
    mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"
    echo "[setup-state-mount] inserted bind mount into $COMPOSE_FILE"
fi

# 3. Recreate ctrl-api
echo "[setup-state-mount] recreating ctrl-api..."
cd /opt/alfred/compose
docker compose -f "$COMPOSE_FILE" up -d --force-recreate ctrl-api

echo "[setup-state-mount] done. Verify with: ls -la $STATE_DIR/"
