#!/usr/bin/env bash
# =============================================================================
# migrate-agents-to-hermes-local.sh
#
# One-shot operator helper to flip an already-seeded Paperclip CEO agent
# from `adapterType: "openclaw_gateway"` (the legacy bootstrap default)
# to `adapterType: "hermes_local"` (the patched HTTP-mode adapter — see
# packages/paperclip/DESIGN.md).
#
# Why this is a separate script (and not folded into bootstrap-paperclip.sh):
# bootstrap-paperclip.sh's idempotency probe (step 2) bails when the
# tenant is already seeded, so a fresh run on a live tenant is a no-op.
# This script targets the existing agent record directly.
#
# Inputs (env):
#   PAPERCLIP_AGENT_ID         — UUID of the agent to migrate (required)
#   PAPERCLIP_AGENT_TOKEN      — the pcp_… runtime key (required; read
#                                from /opt/alfred/.env on a tenant)
#   DOMAIN                     — tenant domain, e.g. home.alfred.black
#                                (read from /opt/alfred/.env)
#   ENABLE_HEARTBEAT           — "1" to also flip
#                                runtimeConfig.heartbeat.enabled true
#                                (default 1; set 0 to keep paused)
#   PAPERCLIP_CONTAINER        — container name (default
#                                alfred-black-paperclip-1)
#
# Usage on a tenant VPS:
#   ssh -o IdentityAgent=none -i ~/.ssh/alfred-black-verify \
#       root@home.alfred.black \
#       'cd /opt/alfred && . .env && \
#        PAPERCLIP_AGENT_ID=694921cb-… \
#        bash /opt/alfred/migrate-agents-to-hermes-local.sh'
#
# Safety:
#   * The script preserves adapterConfig.devicePrivateKeyPem if present
#     (Paperclip generated it for openclaw_gateway; harmless to leave
#     under hermes_local, and removing it might trip a future
#     openclaw_gateway re-migration).
#   * Refuses to run if the agent already has adapterType=hermes_local
#     (idempotent — exit 0, log "already migrated").
#   * Logs the previous adapterType so the operator can roll back.
# =============================================================================
set -euo pipefail

PAPERCLIP_AGENT_ID="${PAPERCLIP_AGENT_ID:?PAPERCLIP_AGENT_ID is required}"
PAPERCLIP_AGENT_TOKEN="${PAPERCLIP_AGENT_TOKEN:?PAPERCLIP_AGENT_TOKEN is required (from /opt/alfred/.env)}"
DOMAIN="${DOMAIN:?DOMAIN is required (from /opt/alfred/.env)}"
ENABLE_HEARTBEAT="${ENABLE_HEARTBEAT:-1}"
PAPERCLIP_CONTAINER="${PAPERCLIP_CONTAINER:-alfred-black-paperclip-1}"

log() { echo "[migrate-agent] $*" >&2; }

# Resolve the live paperclip container if the default name doesn't match
# (multi-tenant compose project names differ — joe is alfred-joe, etc.).
if ! docker inspect "$PAPERCLIP_CONTAINER" >/dev/null 2>&1; then
    resolved=$(docker ps --filter "label=com.docker.compose.service=paperclip" \
        --format '{{.Names}}' 2>/dev/null | head -n1 || true)
    if [[ -n "$resolved" ]]; then
        log "container '$PAPERCLIP_CONTAINER' not found; using '$resolved'"
        PAPERCLIP_CONTAINER="$resolved"
    else
        log "ERROR: no paperclip container found"
        exit 1
    fi
fi

# 1. Read current state.
agent_json=$(docker exec "$PAPERCLIP_CONTAINER" curl -sS \
    -H "Authorization: Bearer $PAPERCLIP_AGENT_TOKEN" \
    -H "Origin: https://paperclip.$DOMAIN" \
    "http://localhost:3100/api/agents/$PAPERCLIP_AGENT_ID")

current_type=$(echo "$agent_json" | python3 -c \
    "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('adapterType') or '')" 2>/dev/null || echo "")

if [[ -z "$current_type" ]]; then
    log "ERROR: could not read current adapterType. Response was:"
    echo "$agent_json" | head -c 500 >&2
    echo "" >&2
    exit 1
fi

log "current adapterType: $current_type"

if [[ "$current_type" == "hermes_local" ]]; then
    log "already migrated — nothing to do"
    exit 0
fi

# 2. Compose the PATCH body — preserve any existing devicePrivateKeyPem.
patch_body=$(echo "$agent_json" | python3 -c "
import sys, json, os
d = json.loads(sys.stdin.read())
prev_config = d.get('adapterConfig') or {}
prev_runtime = d.get('runtimeConfig') or {}
# Carry the device key forward — harmless under hermes_local and lets us
# roll back to openclaw_gateway without losing the identity.
new_config = {}
if isinstance(prev_config, dict) and prev_config.get('devicePrivateKeyPem'):
    new_config['_legacy_devicePrivateKeyPem'] = prev_config['devicePrivateKeyPem']
new_runtime = dict(prev_runtime) if isinstance(prev_runtime, dict) else {}
if os.environ.get('ENABLE_HEARTBEAT', '1') == '1':
    hb = new_runtime.get('heartbeat') or {}
    hb['enabled'] = True
    new_runtime['heartbeat'] = hb
out = {
    'adapterType': 'hermes_local',
    'adapterConfig': new_config,
    'runtimeConfig': new_runtime,
}
print(json.dumps(out))
")

log "patch body: $patch_body"

# 3. PATCH the agent.
patch_response=$(docker exec "$PAPERCLIP_CONTAINER" curl -sS -X PATCH \
    -H "Authorization: Bearer $PAPERCLIP_AGENT_TOKEN" \
    -H "Origin: https://paperclip.$DOMAIN" \
    -H "Content-Type: application/json" \
    -d "$patch_body" \
    "http://localhost:3100/api/agents/$PAPERCLIP_AGENT_ID")

new_type=$(echo "$patch_response" | python3 -c \
    "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('adapterType') or '')" 2>/dev/null || echo "")

if [[ "$new_type" != "hermes_local" ]]; then
    log "ERROR: PATCH did not flip adapterType. Response:"
    echo "$patch_response" | head -c 500 >&2
    echo "" >&2
    exit 1
fi

log "✓ migrated agent $PAPERCLIP_AGENT_ID: openclaw_gateway → hermes_local"
log "  heartbeat enabled: $ENABLE_HEARTBEAT"
log "  rollback: PATCH adapterType back to \"openclaw_gateway\" and restore"
log "  devicePrivateKeyPem from adapterConfig._legacy_devicePrivateKeyPem"
