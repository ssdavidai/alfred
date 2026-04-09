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

# 2a. Vault worker skills from the `alfred` Python package. These are for
# the curator/janitor/distiller daemons, not the user-facing agent.
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

# 2b. Main-agent skills from the platform workspace template. These teach
# the user-facing Alfred how to use its ctrl_* tools (vault operations,
# chore management, learning introspection, ops health). Content lives in
# packages/openclaw/workspace-template/skills/ in the alfred-platform repo
# and gets baked into the init container image via the Dockerfile COPY.
MAIN_SKILLS_SRC="/setup/workspace-template/skills"
if [[ -d "$MAIN_SKILLS_SRC" ]]; then
    for skill_dir in "$MAIN_SKILLS_SRC"/*/; do
        [[ -d "$skill_dir" ]] || continue
        skill=$(basename "$skill_dir")
        SRC_HASH=$(find "$skill_dir" -type f -exec md5sum {} \; | sort | md5sum | cut -d' ' -f1)
        HASH_FILE="$SKILLS_DST/$skill/.content-hash"

        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
            echo "[init] Main skill $skill unchanged, skipping"
        else
            rm -rf "${SKILLS_DST:?}/$skill"
            cp -r "$skill_dir" "$SKILLS_DST/$skill"
            echo "$SRC_HASH" > "$HASH_FILE"
            echo "[init] Main skill $skill copied"
        fi
    done
fi

# 2c. Canonical workspace TOOLS.md — the agent's capability reference.
# Overwrites any previous version on every init run so the agent always
# has the current tool list documented. This replaces the legacy narrative
# "Suggested Tools" TOOLS.md that the onboarding pipeline used to generate.
WORKSPACE_DOCS_SRC="/setup/workspace-template/docs/TOOLS.md"
WORKSPACE_TOOLS_DST="/openclaw-state/workspace/TOOLS.md"
if [[ -f "$WORKSPACE_DOCS_SRC" ]]; then
    SRC_HASH=$(md5sum "$WORKSPACE_DOCS_SRC" | cut -d' ' -f1)
    HASH_FILE="/openclaw-state/workspace/.TOOLS.md.content-hash"
    if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
        echo "[init] Workspace TOOLS.md unchanged, skipping"
    else
        mkdir -p /openclaw-state/workspace
        cp "$WORKSPACE_DOCS_SRC" "$WORKSPACE_TOOLS_DST"
        echo "$SRC_HASH" > "$HASH_FILE"
        echo "[init] Workspace TOOLS.md installed ($(wc -c < "$WORKSPACE_TOOLS_DST") bytes)"
    fi
fi

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

# (b) Workers-only: disable memory plugin + aggressive session maintenance + rate limiting
# Safe because workers only run stateless agents (clerk, curator, janitor, etc.)
# The main openclaw instance keeps memory enabled for the user-facing Alfred.
if is_workers:
    plugins = c.setdefault('plugins', {})
    slots = plugins.setdefault('slots', {})
    slots['memory'] = 'none'
    # Serialize all LLM calls — max 1 concurrent agent run across all sessions.
    # Prevents burst of parallel calls that blow through Gemini's 4M TPM limit.
    defaults = c.setdefault('agents', {}).setdefault('defaults', {})
    defaults['maxConcurrent'] = 1
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

# --- 7b. Ensure main openclaw exposes the full Alfred ctrl_* tool set ---
# Before this step, fresh tenants defaulted to a 10-tool allowlist (just
# vault CRUD + stream_ingest + sessions). That meant the user-facing Alfred
# couldn't use any of the 35 platform tools: admin/workers/workflows/
# schedules/learning/streams-read/vault-delete/vault-graph/etc. This merge
# brings every fresh tenant up to the full 45-tool surface so the agent
# can actually manage chores, introspect learning, check ops health, etc.
#
# Only touches the main openclaw gateway config, NOT openclaw-workers —
# background agents (curator/janitor/distiller/surveyor) have their own
# narrow scopes and don't need (shouldn't have) admin-level tools.
MAIN_CFG=/openclaw-state/openclaw.json
if [[ -f "$MAIN_CFG" ]]; then
    python3 -c "
import json
p = '$MAIN_CFG'
with open(p) as f: c = json.load(f)

# Canonical full allowlist for the main Alfred agent.
# Must stay in sync with packages/openclaw/workspace-template/docs/TOOLS.md
# and the ctrl-api tool registry at packages/ctrl/src/api/routes/tools.ts.
full_allow = [
    # Session / subagent control
    'sessions_send', 'sessions_spawn', 'sessions_history', 'sessions_list',
    # Vault — read
    'ctrl_vault_read', 'ctrl_vault_list', 'ctrl_vault_search',
    'ctrl_vault_context', 'ctrl_vault_inbox', 'ctrl_vault_graph', 'ctrl_vault_schema',
    # Vault — write
    'ctrl_vault_create', 'ctrl_vault_update', 'ctrl_vault_inbox_add', 'ctrl_vault_delete',
    # Streams
    'ctrl_stream_ingest', 'ctrl_streams_list', 'ctrl_streams_events',
    # Learning
    'ctrl_learning_status', 'ctrl_learning_observations', 'ctrl_learning_instincts',
    'ctrl_learning_reflections', 'ctrl_learning_sessions', 'ctrl_learning_queue',
    'ctrl_learning_enable', 'ctrl_learning_disable',
    # Workflows
    'ctrl_workflows_list', 'ctrl_workflows_get', 'ctrl_workflows_start', 'ctrl_workflows_cancel',
    # Schedules
    'ctrl_schedules_list', 'ctrl_schedules_trigger', 'ctrl_schedules_pause', 'ctrl_schedules_unpause',
    # Workers
    'ctrl_workers_status', 'ctrl_workers_restart',
    # Admin / ops
    'ctrl_admin_dashboard', 'ctrl_admin_health', 'ctrl_admin_containers',
    'ctrl_admin_system_info', 'ctrl_admin_activity', 'ctrl_admin_models',
    'ctrl_container_logs', 'ctrl_credentials_list', 'ctrl_service_restart',
]

gateway = c.setdefault('gateway', {})
tools = gateway.setdefault('tools', {})
before = set(tools.get('allow', []))
merged = sorted(before | set(full_allow))
added = set(merged) - before
if added:
    tools['allow'] = merged
    with open(p, 'w') as f: json.dump(c, f, indent=2)
    print(f'[init] Added {len(added)} tools to gateway.tools.allow (now {len(merged)})')
else:
    print(f'[init] gateway.tools.allow already has all {len(merged)} tools')
" 2>/dev/null || true
fi

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

# Chore system: where dynamic chore template files live (Step 4 of the
# bespoke chore generation system). The dynamic loader in alfred-learn
# scans this directory at startup, validates each .py via Layer 2 static
# checks, and stages valid templates into /app/src/workflows/chores_dynamic/
# inside the alfred-learn container. Created here so the directory exists
# from first boot — the loader handles missing-dir gracefully but pre-
# creating it avoids spurious "directory not found" log messages on every
# new tenant.
mkdir -p /alfred-data/user-chores
chmod 777 /alfred-data/user-chores 2>/dev/null || true

# Chore system: snapshot directory used by chore template workflows
# (e.g. SubscriptionWatcherWorkflow saves last-week's events here so
# the next run can diff). Pre-created for the same reason as user-chores.
mkdir -p /alfred-data/chore-snapshots
chmod 777 /alfred-data/chore-snapshots 2>/dev/null || true

echo "=== Init complete ==="
