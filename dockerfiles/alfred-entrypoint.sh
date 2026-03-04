#!/usr/bin/env bash
# Alfred container entrypoint — waits for config, loads .env, starts daemons.
set -euo pipefail

CONFIG="/app/data/config.yaml"
ENV_FILE="/app/data/.env"
TOKEN_FILE="/app/data/.gateway-token"

# Wait for init container to generate config
echo "[alfred] Waiting for config.yaml..."
TRIES=0
while [[ ! -f "$CONFIG" ]]; do
    sleep 2
    TRIES=$((TRIES + 1))
    if [[ $TRIES -ge 30 ]]; then
        echo "[alfred] ERROR: config.yaml not found after 60s"
        exit 1
    fi
done
echo "[alfred] Config found"

# Load .env if present
if [[ -f "$ENV_FILE" ]]; then
    set -a
    source "$ENV_FILE"
    set +a
fi

# Load gateway token if present
if [[ -f "$TOKEN_FILE" ]]; then
    export OPENCLAW_GATEWAY_TOKEN
    OPENCLAW_GATEWAY_TOKEN=$(cat "$TOKEN_FILE")
fi

# Create data directory
mkdir -p /app/data

echo "[alfred] Starting daemons..."
exec alfred --config "$CONFIG" up
