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
# the user-facing Alfred how to use its MCP tools (self for local ctrl-api,
# plus vault / chore / learning / ops-health operation patterns). Content
# lives in packages/openclaw/workspace-template/skills/ in the
# alfred-platform repo and gets baked into the init container image via
# the Dockerfile COPY.
#
# The alfred-prime-federation skill is Prime-only (explains the `tenant`
# and `ask_alfred` cross-tenant tools). It's copied only when ALFRED_PRIME
# is set — non-prime tenants never see documentation for tools they don't
# have, so the agent can't be tempted to try calling them.
MAIN_SKILLS_SRC="/setup/workspace-template/skills"
if [[ -d "$MAIN_SKILLS_SRC" ]]; then
    for skill_dir in "$MAIN_SKILLS_SRC"/*/; do
        [[ -d "$skill_dir" ]] || continue
        skill=$(basename "$skill_dir")

        # Gate Prime-only skills
        if [[ "$skill" == "alfred-prime-federation" && "${ALFRED_PRIME:-}" != "true" ]]; then
            # If somehow present from a previous prime-enabled run, remove it
            if [[ -d "$SKILLS_DST/$skill" ]]; then
                rm -rf "${SKILLS_DST:?}/$skill"
                echo "[init] Main skill $skill removed (tenant is not Alfred Prime)"
            fi
            continue
        fi

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

# 2d. Deploy MCP server script to openclaw workspace.
# The ctrl-server.mjs MCP server provides a single `ctrl` tool that calls
# the tenant's ctrl-api, replacing bash+curl. Deployed to both main openclaw
# and openclaw-workers state dirs.
MCP_SRC="/setup/mcp/ctrl-server.mjs"
if [[ -f "$MCP_SRC" ]]; then
    SRC_HASH=$(md5sum "$MCP_SRC" | cut -d' ' -f1)
    for state_dir in /openclaw-state /openclaw-workers-state; do
        [[ -d "$state_dir" ]] || continue
        MCP_DST="$state_dir/mcp"
        mkdir -p "$MCP_DST"
        HASH_FILE="$MCP_DST/.ctrl-server.content-hash"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
            echo "[init] MCP ctrl-server unchanged in $state_dir, skipping"
        else
            cp "$MCP_SRC" "$MCP_DST/ctrl-server.mjs"
            echo "$SRC_HASH" > "$HASH_FILE"
            echo "[init] MCP ctrl-server deployed to $state_dir/mcp/"
        fi
    done
fi

# 2e. Deploy the 5-app stdio MCP bundle (MCP-4). Same tool catalog the HTTP
# MCP server in alfred-mcp-server exposes to claude.ai Custom Connectors —
# served over stdio here so each tenant's openclaw runtimes can spawn the
# 5 servers (alfred, sure, plane, vaultwarden, execute) as child processes
# and surface them to learn-clerk on main + ephemeral exec-* subagents on
# workers. Source: packages/mcp-server/src/bin/stdio-app.ts compiled in
# stage 1 of init/Dockerfile.
#
# Idempotent: rsync --checksum --delete keeps the destination in lockstep
# with /setup/mcp-stdio while detecting genuine content changes via md5,
# not mtime. The hash-stamp on the directory short-circuits the rsync
# entirely when nothing changed — bundles are ~13 MB so the savings
# matter on tenants that restart init frequently.
MCP_STDIO_SRC="/setup/mcp-stdio"
if [[ -d "$MCP_STDIO_SRC" ]]; then
    BUNDLE_HASH=$(find "$MCP_STDIO_SRC" -type f -not -name '.*' \
        -exec md5sum {} \; | sort | md5sum | cut -d' ' -f1)
    for state_dir in /openclaw-state /openclaw-workers-state; do
        [[ -d "$state_dir" ]] || continue
        MCP_STDIO_DST="$state_dir/mcp-stdio"
        HASH_FILE="$state_dir/.mcp-stdio.content-hash"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$BUNDLE_HASH" ]]; then
            echo "[init] MCP stdio bundle unchanged in $state_dir, skipping"
        else
            mkdir -p "$MCP_STDIO_DST"
            rsync -a --delete "$MCP_STDIO_SRC/" "$MCP_STDIO_DST/"
            echo "$BUNDLE_HASH" > "$HASH_FILE"
            echo "[init] MCP stdio bundle deployed to $state_dir/mcp-stdio/"
        fi
    done
fi

# 2f. Deploy AGENTS.md to each tenant's openclaw state. The executor
# prompt in signal_actions.dispatch_action_to_agent (MCP-5) references
# this file at /home/node/.openclaw/AGENTS.md instead of inlining a
# stale hardcoded tool list. Source: packages/mcp-server/instructions/
# alfred-custom-instructions.md — same instructions doc claude.ai's
# Custom Connector loads when the user adds Alfred as a connector.
AGENTS_SRC="/setup/AGENTS.md"
if [[ -f "$AGENTS_SRC" ]]; then
    AGENTS_HASH=$(md5sum "$AGENTS_SRC" | cut -d' ' -f1)
    for state_dir in /openclaw-state /openclaw-workers-state; do
        [[ -d "$state_dir" ]] || continue
        AGENTS_DST="$state_dir/AGENTS.md"
        HASH_FILE="$state_dir/.agents-md.content-hash"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$AGENTS_HASH" ]]; then
            echo "[init] AGENTS.md unchanged in $state_dir, skipping"
        else
            cp "$AGENTS_SRC" "$AGENTS_DST"
            echo "$AGENTS_HASH" > "$HASH_FILE"
            echo "[init] AGENTS.md deployed to $state_dir/AGENTS.md"
        fi
    done
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

# Note: Ollama embedding model (nomic-embed-text) is auto-pulled by the
# ollama service itself at startup via its command override. See the
# `ollama` service in docker-compose.yaml.njk. Idempotent — Ollama skips
# if the model is already present in the persistent volume.

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
    # Force builtin memory backend — QMD on workers causes OOM crash loops
    # (it tries to embed the entire vault on boot, exceeding V8 heap limit)
    c['memory'] = {'backend': 'builtin', 'citations': 'off'}
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

# --- 7b. Ensure session/subagent control tools are in gateway.tools.allow ---
# Historical context: this step previously merged 41 legacy `ctrl_*` tool
# names into gateway.tools.allow (vault/learning/streams/workflows/schedules/
# workers/admin). Those names referenced the ctrl-api TOOLS registry but
# never corresponded to standalone callable tools in OpenClaw — the registry
# uses unprefixed names ('vault_read', not 'ctrl_vault_read'), and even then
# the only agent-facing surface for those endpoints is the MCP `ctrl` tool
# (registered in step 7c) which calls them via /api/v1/tools/invoke or
# directly via /api/v1/<route>.
#
# Removing the legacy entries keeps the allowlist minimal and accurate.
# `composio_execute` is still managed dynamically by integrations.ts on
# connect/disconnect — that's preserved.
#
# Sessions tools ARE real built-in OpenClaw tools and remain in the list.
MAIN_CFG=/openclaw-state/openclaw.json
WORKERS_CFG=/openclaw-workers-state/openclaw.json
for TARGET_CFG in "$MAIN_CFG" "$WORKERS_CFG"; do
[[ -f "$TARGET_CFG" ]] || continue
    python3 -c "
import json
p = '$TARGET_CFG'
with open(p) as f: c = json.load(f)

# Real built-in OpenClaw session/subagent + outbound messaging tools —
# these correspond to actual callable tools and belong in the allowlist.
# `message` is openclaw's outbound channel-delivery primitive (Slack,
# Telegram, etc.). Chores and platform notifications go through it.
session_tools = {
    'message',
    'sessions_send', 'sessions_spawn', 'sessions_history',
    'sessions_list', 'sessions_delete',
}

gateway = c.setdefault('gateway', {})
tools = gateway.setdefault('tools', {})
current = set(tools.get('allow', []))

# Add missing sessions tools
to_add = session_tools - current
# Remove ghost ctrl_* legacy entries (they reference nothing callable)
to_remove = {t for t in current if t.startswith('ctrl_') and t != 'ctrl_composio_execute'}

if to_add or to_remove:
    new_allow = sorted((current | to_add) - to_remove)
    tools['allow'] = new_allow
    with open(p, 'w') as f: json.dump(c, f, indent=2)
    msg = []
    if to_add: msg.append(f'added {len(to_add)} sessions tools')
    if to_remove: msg.append(f'removed {len(to_remove)} legacy ctrl_* entries')
    print(f'[init] gateway.tools.allow: {\"; \".join(msg)} (now {len(new_allow)} entries) in {p}')
else:
    print(f'[init] gateway.tools.allow already correct ({len(current)} entries) in {p}')
" 2>/dev/null || true
done

# --- 7c. Register MCP server for ctrl-api access ---
# Adds mcp.servers.alfred-ctrl so OpenClaw spawns the ctrl MCP server on
# first session. Env vars must be passed explicitly because MCP child
# processes only inherit a small set of default env vars.
#
# The MCP server exposes `self` on all tenants. When ALFRED_PRIME=true is
# set on the host (only on David's instance), it additionally exposes the
# `tenant` and `ask_alfred` cross-tenant tools and reads CROSS_TENANT_PEERS
# for peer discovery.
for TARGET_CFG in "$MAIN_CFG" "$WORKERS_CFG"; do
    [[ -f "$TARGET_CFG" ]] || continue
    python3 -c "
import json, os
p = '$TARGET_CFG'
with open(p) as f: c = json.load(f)

aas_key = os.environ.get('AAS_API_KEY', '')
alfred_prime = os.environ.get('ALFRED_PRIME', '')
cross_tenant_peers = os.environ.get('CROSS_TENANT_PEERS', '')

env_block = {
    'CTRL_API_URL': 'http://ctrl-api:3100',
    'AAS_API_KEY': aas_key,
    'NODE_PATH': '/app/node_modules',
}
# Only forward prime vars when actually set on the host, so non-prime
# tenants never see these keys and can't accidentally register the
# cross-tenant tools.
if alfred_prime:
    env_block['ALFRED_PRIME'] = alfred_prime
if cross_tenant_peers:
    env_block['CROSS_TENANT_PEERS'] = cross_tenant_peers

mcp = c.setdefault('mcp', {})
servers = mcp.setdefault('servers', {})
desired = {
    'command': 'node',
    'args': ['/home/node/.openclaw/mcp/ctrl-server.mjs'],
    'env': env_block,
}

current = servers.get('alfred-ctrl', {})
if current != desired:
    servers['alfred-ctrl'] = desired
    with open(p, 'w') as f: json.dump(c, f, indent=2)
    mode = 'prime' if alfred_prime == 'true' else 'self-only'
    print(f'[init] MCP server alfred-ctrl registered ({mode}) in {p}')
else:
    print(f'[init] MCP server alfred-ctrl already configured in {p}')
" 2>/dev/null || true
done

# --- 7d. Register the 5-app stdio MCP servers (MCP-4) ---
# Same tool catalog the HTTP alfred-mcp-server exposes to claude.ai
# Custom Connectors. Each entry spawns
# /home/node/.openclaw/mcp-stdio/dist/bin/stdio-app.js <appId>; the
# bundle on the volume came from section 2e above. Idempotent: only
# writes when the resolved entry actually differs.
for TARGET_CFG in "$MAIN_CFG" "$WORKERS_CFG"; do
    [[ -f "$TARGET_CFG" ]] || continue
    python3 -c "
import json, os
p = '$TARGET_CFG'
with open(p) as f: c = json.load(f)

aas_key = os.environ.get('AAS_API_KEY', '')
env_block = {
    'CTRL_API_URL': 'http://ctrl-api:3100',
    'AAS_API_KEY': aas_key,
}
mcp = c.setdefault('mcp', {})
servers = mcp.setdefault('servers', {})
changed = []
for app in ('alfred', 'sure', 'plane', 'vaultwarden', 'execute'):
    desired = {
        'command': 'node',
        'args': ['/home/node/.openclaw/mcp-stdio/dist/bin/stdio-app.js', app],
        'env': env_block,
    }
    if servers.get(app) != desired:
        servers[app] = desired
        changed.append(app)

if changed:
    with open(p, 'w') as f: json.dump(c, f, indent=2)
    print(f'[init] MCP servers registered/updated in {p}: {changed}')
else:
    print(f'[init] MCP servers (5-app) already configured in {p}')
" 2>/dev/null || true
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

# --- 10. Backfill COMPOSIO_USER_ID for existing tenants ---
# Fresh tenants get COMPOSIO_USER_ID injected into .env by the provisioner
# (packages/ctrl/src/infra/provisioner.ts). Existing tenants provisioned
# before #408 do not have it set, which means their Composio connections
# leak across the fleet (everyone shares the "default" namespace).
#
# We can't rewrite /opt/alfred/compose/.env from inside the init container
# (the host compose dir is not mounted), so we write a fallback file that
# both ctrl-api (TS) and composio_client (Python) read when the env var is
# missing. The tenant identity is derived from the hostname, which the
# provisioner sets to `alfred-<customer_name>`.
#
# This step is idempotent — skips if the file already has a non-default
# value, so a newer .env override always wins.
COMPOSIO_UID_FILE=/alfred-data/.composio-user-id
EXISTING_UID=""
if [[ -f "$COMPOSIO_UID_FILE" ]]; then
    EXISTING_UID=$(tr -d '[:space:]' < "$COMPOSIO_UID_FILE")
fi
ENV_UID="${COMPOSIO_USER_ID:-}"
if [[ -n "$ENV_UID" && "$ENV_UID" != "default" ]]; then
    # Prefer env-provided value — mirror it into the file so workers (which
    # read from the file as fallback when their env is stale) stay consistent.
    if [[ "$EXISTING_UID" != "$ENV_UID" ]]; then
        echo -n "$ENV_UID" > "$COMPOSIO_UID_FILE"
        echo "[init] Mirrored COMPOSIO_USER_ID=$ENV_UID to $COMPOSIO_UID_FILE"
    else
        echo "[init] COMPOSIO_USER_ID already mirrored to $COMPOSIO_UID_FILE"
    fi
elif [[ -n "$EXISTING_UID" && "$EXISTING_UID" != "default" ]]; then
    echo "[init] COMPOSIO_USER_ID backfill file already present ($EXISTING_UID), env missing — consider adding COMPOSIO_USER_ID=$EXISTING_UID to /opt/alfred/compose/.env"
else
    # No env var, no backfill file. We deliberately do NOT derive a value
    # from hostname: the provisioner writes COMPOSIO_USER_ID as
    # `alfred-<slug>-<instance_id>` where <instance_id> is the SaaS-side
    # Instance row id (not available inside the container). Any hostname-
    # derived value would be a different shape and would NOT match what
    # the migration script or dashboard expects — producing orphaned
    # Composio connections that can't be reconciled later.
    echo "[init] ACTION REQUIRED: COMPOSIO_USER_ID is not set and no backfill file exists."
    echo "[init]   Composio per-tenant isolation is DISABLED until this is configured."
    echo "[init]   To fix: on the host, edit /opt/alfred/compose/.env and add:"
    echo "[init]     COMPOSIO_USER_ID=alfred-<slug>-<instance_id>"
    echo "[init]   then run: docker compose up -d --force-recreate"
    echo "[init]   (Composio integration is optional, continuing init with status 0.)"
fi
chmod 644 "$COMPOSIO_UID_FILE" 2>/dev/null || true

# --- 11. Seed /vault/.auth/authorized_senders.json for the email channel ---
#
# Email inbound to the tenant's AgentMail inbox is dispatched in one of two
# modes: authorized-sender → openclaw main agent (channel), anyone else →
# learn zero-LLM stream ingest. The authorized list is seeded here with
# exactly the tenant owner's email (from the OWNER_EMAIL env var set by the
# provisioner); no auto-promote, no wildcards. Sir adds others later via
# dashboard or /api/v1/auth/senders.
#
# Idempotent: only seeds if the file doesn't exist yet. Respects any manual
# edits Sir makes later.
AUTH_DIR=/vault/.auth
AUTH_FILE="$AUTH_DIR/authorized_senders.json"
if [[ -f "$AUTH_FILE" ]]; then
    echo "[init] authorized_senders.json already present, leaving alone"
elif [[ -n "${OWNER_EMAIL:-}" ]]; then
    mkdir -p "$AUTH_DIR"
    OWNER_EMAIL_LOWER=$(echo "$OWNER_EMAIL" | tr '[:upper:]' '[:lower:]')
    cat > "$AUTH_FILE" <<JSON
{
  "senders": ["$OWNER_EMAIL_LOWER"],
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
    chmod 644 "$AUTH_FILE" 2>/dev/null || true
    echo "[init] Seeded authorized_senders.json with $OWNER_EMAIL_LOWER"
else
    echo "[init] OWNER_EMAIL not set — skipping authorized_senders.json seed."
    echo "[init]   (Email channel will have NO authorized senders until manually configured.)"
fi

# --- 12. Stage Sure (sure.am) first-boot bootstrap inputs ---
#
# Sure is an optional Rails sidecar (https://sure.am, github we-promise/sure).
# It ships with no admin user and no API key, and it has no `sure:bootstrap`
# rake task — the only way to mint an API key is to call ApiKey on a Rails
# console / runner attached to its Postgres database (see
# app/controllers/settings/api_keys_controller.rb in we-promise/sure).
#
# The init container (this script) cannot reach Sure's DB and has no Docker
# socket, so it cannot run `bin/rails runner` itself. Following the same
# precedent as `temporal-namespace-init` in docker-compose.yaml.njk, the
# actual mint is done by a separate one-shot compose service (`sure-init`,
# owned by W1A) that:
#
#   - uses the same image as the `sure-web` service (it needs Rails + DB
#     credentials that are already configured for sure-web)
#   - depends_on: sure-web: condition: service_healthy   (sure-web's
#     `/up` endpoint is the standard Rails health check, see config/routes.rb)
#   - mounts /alfred-data:/alfred-data (the same shared volume init writes to)
#   - runs:  bin/rails runner /alfred-data/sure-bootstrap/bootstrap.rb
#
# Init's job here is to stage everything that Ruby script needs:
#   1. Skip entirely unless SURE_ENABLED=true (set by W1A's compose block).
#   2. Skip entirely if /alfred-data/.sure-api-key already exists (idempotent).
#   3. Require OWNER_EMAIL (provisioner-supplied env, see step 11).
#   4. Generate a 32-char URL-safe random password, write it to
#      /alfred-data/.sure-bootstrap-password (mode 0600). The password must
#      satisfy Sure's RegistrationsController rules: >=8 chars, upper+lower,
#      digit, special. We force a special char + digit suffix so token_urlsafe
#      output (which is base64url and may lack both) always passes.
#   5. Mirror OWNER_EMAIL to /alfred-data/.sure-bootstrap-email so the Ruby
#      script doesn't depend on inheriting env from the sure-init container.
#   6. Deploy bootstrap.rb (baked into this image) to
#      /alfred-data/sure-bootstrap/bootstrap.rb.
#
# After sure-init runs successfully, /alfred-data/.sure-api-key contains the
# plaintext API key. Operator action: copy that value into
# /opt/alfred/compose/.env as SURE_API_KEY=<value> and recreate the alfred
# stack (the init container cannot write to the host's compose .env — same
# fallback pattern as .composio-user-id above).
if [[ "${SURE_ENABLED:-false}" != "true" ]]; then
    echo "[init] SURE_ENABLED!=true, skipping Sure bootstrap staging."
else
    # Note: previously this block was short-circuited when /alfred-data/
    # .sure-api-key already existed — an over-aggressive guard meant for
    # bootstrap idempotency. The guard also blocked re-staging of the
    # account-mutation script (and any future Rails-runner helpers), so
    # tenants stayed stuck on whatever script revision was current the
    # first time they bootstrapped. The staging steps below are each
    # individually idempotent (content-hash gated for scripts; conditional
    # creation for the bootstrap password), so we always run them.
    if [[ -z "${OWNER_EMAIL:-}" ]]; then
        echo "[init] ACTION REQUIRED: SURE_ENABLED=true but OWNER_EMAIL is unset."
        echo "[init]   Cannot stage Sure bootstrap without an admin email."
        echo "[init]   Fix: set OWNER_EMAIL=<owner@example.com> in /opt/alfred/compose/.env and recreate."
    else
        SURE_EMAIL_FILE=/alfred-data/.sure-bootstrap-email
        SURE_PW_FILE=/alfred-data/.sure-bootstrap-password
        SURE_SCRIPT_DIR=/alfred-data/sure-bootstrap
        SURE_SCRIPT_DST="$SURE_SCRIPT_DIR/bootstrap.rb"
        SURE_SCRIPT_SRC=/setup/sure-bootstrap.rb

        # Both bootstrap files must be readable by sure-init's non-root rails
        # user (uid 1000), otherwise bin/rails runner gets EACCES on read.
        # /alfred-data is on the encrypted volume, only mounted into trusted
        # containers, so 0644 is fine.
        OWNER_EMAIL_LOWER=$(echo "$OWNER_EMAIL" | tr '[:upper:]' '[:lower:]')
        echo -n "$OWNER_EMAIL_LOWER" > "$SURE_EMAIL_FILE"
        chmod 644 "$SURE_EMAIL_FILE" 2>/dev/null || true

        if [[ ! -f "$SURE_PW_FILE" || ! -s "$SURE_PW_FILE" ]]; then
            # Build a password that satisfies Sure RegistrationsController:
            # base = token_urlsafe(24) (>=32 chars, mixed-case + digits, base64url
            # alphabet has no special chars), then suffix "!Aa1" to force a
            # guaranteed special char on top of upper/lower/digit. Final length
            # ~36 chars, well over the 8-char minimum.
            SURE_PW=$(python3 -c "import secrets; print(secrets.token_urlsafe(24) + '!Aa1')")
            printf '%s' "$SURE_PW" > "$SURE_PW_FILE"
            chmod 644 "$SURE_PW_FILE" 2>/dev/null || true
            echo "[init] Generated Sure bootstrap password at $SURE_PW_FILE (mode 0644)"
        else
            chmod 644 "$SURE_PW_FILE" 2>/dev/null || true
            echo "[init] Sure bootstrap password already present at $SURE_PW_FILE, reusing"
        fi

        if [[ -f "$SURE_SCRIPT_SRC" ]]; then
            mkdir -p "$SURE_SCRIPT_DIR"
            SURE_SRC_HASH=$(md5sum "$SURE_SCRIPT_SRC" | cut -d' ' -f1)
            SURE_HASH_FILE="$SURE_SCRIPT_DIR/.bootstrap.rb.content-hash"
            if [[ -f "$SURE_HASH_FILE" && "$(cat "$SURE_HASH_FILE")" == "$SURE_SRC_HASH" && -f "$SURE_SCRIPT_DST" ]]; then
                echo "[init] Sure bootstrap.rb unchanged, skipping copy"
            else
                cp "$SURE_SCRIPT_SRC" "$SURE_SCRIPT_DST"
                echo "$SURE_SRC_HASH" > "$SURE_HASH_FILE"
                chmod 644 "$SURE_SCRIPT_DST" 2>/dev/null || true
                echo "[init] Deployed Sure bootstrap.rb to $SURE_SCRIPT_DST"
            fi
        else
            echo "[init] WARNING: $SURE_SCRIPT_SRC missing from image — Sure bootstrap will fail."
        fi

        # Shared library file — required by every sure-*-mutate.rb script
        # via require_relative, so it must land in the same staging dir.
        # NOT in the runner-script loop below because ctrl-api never
        # invokes it directly (it has no `case op` dispatch).
        SURE_BASE_SRC=/setup/sure-mutate-base.rb
        SURE_BASE_DST="$SURE_SCRIPT_DIR/sure-mutate-base.rb"
        if [[ -f "$SURE_BASE_SRC" ]]; then
            SURE_BASE_HASH=$(md5sum "$SURE_BASE_SRC" | cut -d' ' -f1)
            SURE_BASE_HASH_FILE="$SURE_SCRIPT_DIR/.sure-mutate-base.rb.content-hash"
            if [[ -f "$SURE_BASE_HASH_FILE" && "$(cat "$SURE_BASE_HASH_FILE")" == "$SURE_BASE_HASH" && -f "$SURE_BASE_DST" ]]; then
                echo "[init] sure-mutate-base.rb unchanged, skipping copy"
            else
                cp "$SURE_BASE_SRC" "$SURE_BASE_DST"
                echo "$SURE_BASE_HASH" > "$SURE_BASE_HASH_FILE"
                chmod 644 "$SURE_BASE_DST" 2>/dev/null || true
                echo "[init] Deployed sure-mutate-base.rb to $SURE_BASE_DST"
            fi
        else
            echo "[init] WARNING: $SURE_BASE_SRC missing from image — every sure-*-mutate.rb script will fail at require_relative."
        fi

        # Mutation scripts — give ctrl-api Rails-runner-backed CRUD paths
        # for surfaces Sure's REST API doesn't expose (accounts, rules,
        # transfers, entries, …). All hash-gated so re-running init is
        # idempotent.
        for SCRIPT in sure-account-mutate.rb sure-rule-mutate.rb sure-transfer-mutate.rb sure-entry-mutate.rb sure-category-mutate.rb sure-tag-mutate.rb sure-merchant-mutate.rb sure-holding-mutate.rb sure-valuation-mutate.rb sure-recurring-mutate.rb sure-duplicate-mutate.rb sure-share-mutate.rb sure-invitation-mutate.rb sure-budget-mutate.rb sure-export-mutate.rb sure-settings-mutate.rb; do
            SURE_MUT_SRC=/setup/$SCRIPT
            SURE_MUT_DST="$SURE_SCRIPT_DIR/$SCRIPT"
            if [[ -f "$SURE_MUT_SRC" ]]; then
                SURE_MUT_HASH=$(md5sum "$SURE_MUT_SRC" | cut -d' ' -f1)
                SURE_MUT_HASH_FILE="$SURE_SCRIPT_DIR/.$SCRIPT.content-hash"
                if [[ -f "$SURE_MUT_HASH_FILE" && "$(cat "$SURE_MUT_HASH_FILE")" == "$SURE_MUT_HASH" && -f "$SURE_MUT_DST" ]]; then
                    echo "[init] $SCRIPT unchanged, skipping copy"
                else
                    cp "$SURE_MUT_SRC" "$SURE_MUT_DST"
                    echo "$SURE_MUT_HASH" > "$SURE_MUT_HASH_FILE"
                    chmod 644 "$SURE_MUT_DST" 2>/dev/null || true
                    echo "[init] Deployed $SCRIPT to $SURE_MUT_DST"
                fi
            else
                echo "[init] WARNING: $SURE_MUT_SRC missing from image — corresponding Sure mutation surface will fail."
            fi
        done

        echo "[init] Sure bootstrap staged. The sure-init compose service must run:"
        echo "[init]   bin/rails runner /alfred-data/sure-bootstrap/bootstrap.rb"
        echo "[init] After it succeeds, copy /alfred-data/.sure-api-key into"
        echo "[init]   /opt/alfred/compose/.env as SURE_API_KEY=<value> and recreate."
    fi
fi

echo "=== Init complete ==="
