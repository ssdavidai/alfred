#!/usr/bin/env bash
# init container — idempotent setup: scaffold vault, copy skills, generate config.
set -euo pipefail

echo "=== Alfred init container ==="

# Resolve bundled paths via the installed Python package
SCAFFOLD_DIR=$(python3 -c "from alfred._data import get_scaffold_dir; print(get_scaffold_dir())")
SKILLS_SRC_DIR=$(python3 -c "from alfred._data import get_skills_dir; print(get_skills_dir())")

# --- 1. Scaffold vault ---
if [[ ! -f /vault/CLAUDE.md ]]; then
    echo "[init] Scaffolding vault from template..."
    rsync -a --ignore-existing "$SCAFFOLD_DIR/" /vault/
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
    SRC_HASH=$(find "$SKILLS_SRC_DIR/$skill" -type f -exec md5sum {} \; | sort | md5sum | cut -d' ' -f1)
    HASH_FILE="$SKILLS_DST/$skill/.content-hash"

    if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
        echo "[init] Skill $skill unchanged, skipping"
    else
        rm -rf "${SKILLS_DST:?}/$skill"
        cp -r "$SKILLS_SRC_DIR/$skill" "$SKILLS_DST/$skill"
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

# --- 6. Sync gateway token into openclaw configs ---
# Ensures both openclaw (main) and openclaw-workers use the same auth token.
# Fixes existing tenants where the tokens diverged (each gateway auto-generated its own).
if [[ -f "$TOKEN_FILE" ]]; then
    GW_TOKEN=$(cat "$TOKEN_FILE")
    for cfg in /openclaw-state/openclaw.json /openclaw-workers-state/openclaw.json; do
        if [[ -f "$cfg" ]]; then
            python3 -c "
import json, sys
p = '$cfg'
t = '$GW_TOKEN'
with open(p) as f: c = json.load(f)
auth = c.setdefault('gateway', {}).setdefault('auth', {})
if auth.get('token') != t:
    auth['token'] = t
    auth['mode'] = 'token'
    with open(p, 'w') as f: json.dump(c, f, indent=2)
    print(f'[init] Synced gateway token to {p}')
else:
    print(f'[init] Gateway token already in sync: {p}')
" 2>/dev/null || true
        fi
    done
fi

# --- 7. Configure stateless agents (disable QMD bloat) ---
# Agents that process items independently (clerk, curator, janitor, distiller,
# surveyor) don't need conversation memory. Without this, their QMD databases
# grow unbounded (~20MB / 400K tokens), causing a compaction death loop that
# burns $30-40/week in wasted input tokens. Ref: post-mortem 2026-04-07.
#
# Two-layer fix:
# a) Per-agent: disable memoryFlush + aggressive session pruning
# b) Global on workers: plugins.slots.memory = "none" (kills QMD entirely)
for cfg in /openclaw-state/openclaw.json /openclaw-workers-state/openclaw.json; do
    if [[ -f "$cfg" ]]; then
        python3 -c "
import json, sys
p = '$cfg'
is_workers = 'workers' in p
with open(p) as f: c = json.load(f)

# (a) Per-agent config for stateless agents — remove heartbeats only
# Note: compaction and session are NOT valid per-agent keys in OpenClaw.
# Session maintenance is handled at the top-level (workers-only, below).
agents = c.get('agents', {}).get('list', [])
stateless = {'learn-clerk', 'vault-curator', 'vault-janitor', 'vault-distiller', 'vault-surveyor'}
for a in agents:
    if a.get('id') in stateless:
        a.pop('heartbeat', None)
        a.pop('compaction', None)   # remove invalid per-agent key
        a.pop('session', None)      # remove invalid per-agent key

# (b) Workers-only: disable memory plugin + aggressive session maintenance
# Safe because workers only run stateless agents (clerk, curator, janitor, etc.)
# The main openclaw instance keeps memory enabled for the user-facing Alfred.
if is_workers:
    plugins = c.setdefault('plugins', {})
    slots = plugins.setdefault('slots', {})
    slots['memory'] = 'none'
    c['session'] = {
        'maintenance': {
            'mode': 'enforce',
            'pruneAfter': '30m',
            'maxEntries': 20,
            'rotateBytes': '1mb',
            'maxDiskBytes': '50mb',
            'highWaterBytes': '10mb',
        }
    }

with open(p, 'w') as f: json.dump(c, f, indent=2)
print(f'[init] Configured stateless agents + memory plugin in {p}')
" 2>/dev/null || true
    fi
done

# --- 8. Reset stateless agent sessions (prevent QMD/transcript bloat) ---
# Stateless agents accumulate session history and QMD data that grows unbounded.
# On every init (container restart), wipe their session transcripts and QMD
# databases. This is safe because these agents don't need conversation memory.
for agent in learn-clerk vault-curator vault-janitor vault-distiller vault-surveyor; do
    AGENT_DIR="/openclaw-state/agents/$agent"
    if [ -d "$AGENT_DIR" ]; then
        rm -f "$AGENT_DIR"/qmd/xdg-cache/qmd/index.sqlite* 2>/dev/null
        rm -f "$AGENT_DIR"/sessions/*.jsonl 2>/dev/null
        echo "[init] Reset session state for $agent"
    fi
    # Same for openclaw-workers state
    WORKER_DIR="/openclaw-workers-state/agents/$agent"
    if [ -d "$WORKER_DIR" ]; then
        rm -f "$WORKER_DIR"/qmd/xdg-cache/qmd/index.sqlite* 2>/dev/null
        rm -f "$WORKER_DIR"/sessions/*.jsonl 2>/dev/null
        echo "[init] Reset session state for $agent (workers)"
    fi
done

# --- 9. Fix permissions ---
# OpenClaw runs as uid 1000 (node user).  The alfred container runs as root
# with cap_add: DAC_OVERRIDE so it can access uid-1000-owned files.
chown -R 1000:1000 /openclaw-state 2>/dev/null || true
chown -R 1000:1000 /openclaw-workers-state 2>/dev/null || true
chown -R 1000:1000 /vault 2>/dev/null || true

# Alfred data needs to be writable by all containers
mkdir -p /alfred-data
chmod -R 777 /alfred-data 2>/dev/null || true

echo "=== Init complete ==="
