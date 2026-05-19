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

# Load gateway token — prefer the live OpenClaw config (it may regenerate
# its token on restart), fall back to the static token file from init.
OPENCLAW_CONFIG="/root/.openclaw/openclaw.json"
if [[ -f "$OPENCLAW_CONFIG" ]]; then
    # Extract token from OpenClaw's live config (most up-to-date source)
    LIVE_TOKEN=$(python3 -c "import json; print(json.load(open('$OPENCLAW_CONFIG')).get('gateway',{}).get('auth',{}).get('token',''))" 2>/dev/null || true)
    if [[ -n "$LIVE_TOKEN" ]]; then
        export OPENCLAW_GATEWAY_TOKEN="$LIVE_TOKEN"
        # Also update the static file so openclaw-wrapper reads it correctly
        echo -n "$LIVE_TOKEN" > "$TOKEN_FILE"
        # OPS-TOKEN-1 fix: alfred-learn runs as uid 1000 inside its own
        # container and shares this file via the /mnt/encrypted/alfred bind
        # mount. Without these perms it reads as root:root mode 600 → all
        # clerk/LLM calls from alfred-learn fail with Permission denied.
        # 0:1000 + 0640 lets alfred-learn's gid 1000 read via group, while
        # keeping root-only write (the alfred container is the only writer).
        chown 0:1000 "$TOKEN_FILE" 2>/dev/null || true
        chmod 0640 "$TOKEN_FILE" 2>/dev/null || true
        echo "[alfred] Token synced from OpenClaw config (perms 0:1000 0640)"
    fi
elif [[ -f "$TOKEN_FILE" ]]; then
    export OPENCLAW_GATEWAY_TOKEN
    OPENCLAW_GATEWAY_TOKEN=$(cat "$TOKEN_FILE")
    # OPS-TOKEN-1 fix: re-apply perms in case the file was created by
    # init under an older umask (mode 600) that blocks alfred-learn.
    chown 0:1000 "$TOKEN_FILE" 2>/dev/null || true
    chmod 0640 "$TOKEN_FILE" 2>/dev/null || true
fi

# Create data directory
mkdir -p /app/data

echo "[alfred] Starting daemons..."
exec alfred --config "$CONFIG" up --foreground
