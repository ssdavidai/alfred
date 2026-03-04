#!/usr/bin/env bash
# init container — idempotent setup: scaffold vault, copy skills, generate config.
set -euo pipefail

echo "=== Alfred init container ==="

# --- 1. Scaffold vault ---
if [[ ! -f /vault/CLAUDE.md ]]; then
    echo "[init] Scaffolding vault from template..."
    rsync -a --ignore-existing /alfred-src/scaffold/ /vault/
    echo "[init] Vault scaffolded"
else
    echo "[init] Vault already scaffolded, skipping"
fi

# Ensure all entity dirs exist (including alfred-learn folders)
ENTITY_DIRS=(
    person project org location process
    inbox inbox/processed inbox/_quarantine
    account asset conversation note
    decision assumption constraint contradiction synthesis
    event dashboard view
    observation intuition/instincts reflection
)
for dir in "${ENTITY_DIRS[@]}"; do
    mkdir -p "/vault/$dir"
done
echo "[init] Entity directories verified"

# --- 2. Copy skills to OpenClaw workspace ---
SKILLS_DST="/openclaw-state/workspace/skills"
mkdir -p "$SKILLS_DST"

for skill in vault-curator vault-janitor vault-distiller; do
    SRC_HASH=$(find "/alfred-src/skills/$skill" -type f -exec md5sum {} \; | sort | md5sum | cut -d' ' -f1)
    HASH_FILE="$SKILLS_DST/$skill/.content-hash"

    if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
        echo "[init] Skill $skill unchanged, skipping"
    else
        rm -rf "${SKILLS_DST:?}/$skill"
        cp -r "/alfred-src/skills/$skill" "$SKILLS_DST/$skill"
        echo "$SRC_HASH" > "$HASH_FILE"
        echo "[init] Skill $skill copied"
    fi
done

# --- 3. Generate Alfred config.yaml ---
if [[ ! -f /alfred-data/config.yaml ]]; then
    echo "[init] Generating config.yaml..."
    export VAULT_PATH="/vault"
    export OPENCLAW_WRAPPER_PATH="/usr/local/bin/openclaw-wrapper"
    export DATA_DIR="/app/data"
    envsubst < ./config.yaml.tpl > /alfred-data/config.yaml
    echo "[init] config.yaml written"
else
    echo "[init] config.yaml exists, preserving user edits"
fi

# --- 4. Auto-generate gateway token if blank ---
TOKEN_FILE="/alfred-data/.gateway-token"
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    if [[ ! -f "$TOKEN_FILE" ]]; then
        TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
        echo "$TOKEN" > "$TOKEN_FILE"
        echo "[init] Generated gateway token"
    else
        echo "[init] Using existing gateway token"
    fi
else
    echo "${OPENCLAW_GATEWAY_TOKEN}" > "$TOKEN_FILE"
    echo "[init] Using provided gateway token"
fi

# --- 5. Initialize observation/intuition base records ---
if [[ ! -f /vault/intuition/index.md ]]; then
    echo "[init] Creating intuition index..."
    CREATED_DATE=$(date -u +%Y-%m-%dT%H:%M:%S)
    cat > /vault/intuition/index.md <<EOF
---
type: note
name: Intuition Index
created: $CREATED_DATE
---

# Intuition Index

Master index of all learned routing patterns (instincts).

## Active Instincts

(Will be populated as the learning engine observes routing decisions)

EOF
fi

# --- 6. Fix permissions ---
# OpenClaw runs as uid 1000 (node user)
chown -R 1000:1000 /openclaw-state 2>/dev/null || true
chown -R 1000:1000 /vault 2>/dev/null || true

# Alfred data needs to be writable
mkdir -p /alfred-data
chmod -R 777 /alfred-data 2>/dev/null || true

echo "=== Init complete ==="
