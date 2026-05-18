#!/usr/bin/env bash
# =============================================================================
# init container — idempotent one-shot bootstrap for alfred-black.
#
# Runs once at `docker compose up` (a `service_completed_successfully` gate
# for the rest of the stack). Retargeted from OpenClaw to Hermes:
#
#   KEPT   — vault scaffold, skills + MCP-bundle deploy, alfred config.yaml,
#            gateway-token generation, intuition index, Composio UID
#            backfill, email authorized-senders seed, Sure bootstrap staging.
#   DELETED— openclaw.json token-sync, openclaw.json allowlist / stateless-
#            agent surgery, the `.jsonl` session-reset step. Hermes has no
#            openclaw.json and its SQLite SessionStore makes the readdir
#            failure mode that the reset step existed for impossible.
#   ADDED  — render the per-profile Hermes config.yaml + .env from the
#            .njk templates (token → API_SERVER_KEY).
#
# Volume layout (compose):
#   /vault           ← named volume `vault_data`     (the markdown vault)
#   /alfred-data     ← named volume `alfred_data`    (shared scratch + token)
#   /hermes-data     ← named volume `hermes_data`    (Hermes HERMES_HOME)
#
# The hermes runtime container mounts the SAME `hermes_data` volume at
# /opt/data. So a path written INTO a rendered config.yaml must use the
# RUNTIME view (/opt/data/...), while this script writes through the INIT
# view (/hermes-data/...). HERMES_RUNTIME_HOME / HERMES_DATA_DIR carry
# those two views.
# =============================================================================
set -euo pipefail

echo "=== alfred-black init container ==="

# --- Path configuration ------------------------------------------------------
# Where THIS container sees the Hermes volume.
HERMES_DATA_DIR="${HERMES_DATA_DIR:-/hermes-data}"
# Where the HERMES RUNTIME container sees the same volume (its HERMES_HOME).
HERMES_RUNTIME_HOME="${HERMES_RUNTIME_HOME:-/opt/data}"
PROFILES=(main workers)

# Resolve bundled paths via the installed alfred Python package.
SCAFFOLD_DIR=$(python3 -c "from alfred._data import get_scaffold_dir; print(get_scaffold_dir())")
SKILLS_SRC_DIR=$(python3 -c "from alfred._data import get_skills_dir; print(get_skills_dir())")

# --- 1. Scaffold vault -------------------------------------------------------
if [[ ! -f /vault/CLAUDE.md ]]; then
    echo "[init] Scaffolding vault from template..."
    rsync -a --ignore-existing "$SCAFFOLD_DIR/" /vault/
    echo "[init] Vault scaffolded"
else
    echo "[init] Vault already scaffolded, skipping"
fi

# Ensure all entity dirs exist (including alfred-learn folders).
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

# =============================================================================
# 2. Deploy skills + MCP bundle into each Hermes profile dir.
#
# A Hermes profile lives at ${HERMES_HOME}/profiles/<name>/. Each profile
# gets its own copy of: skills/, mcp-stdio/ (the 5-app bundle), mcp/
# (ctrl-server.mjs), AGENTS.md, and a workspace/ scratch dir.
# =============================================================================
for profile in "${PROFILES[@]}"; do
    PROFILE_DIR="$HERMES_DATA_DIR/profiles/$profile"
    mkdir -p "$PROFILE_DIR/skills" "$PROFILE_DIR/workspace" "$PROFILE_DIR/mcp"
    echo "[init] Profile dir ready: $PROFILE_DIR"
done

# --- 2a. Vault-worker skills (curator/janitor/distiller) ---------------------
# From the `alfred` Python package — for the vault-worker daemons. Deployed
# into BOTH profiles (the workers profile runs them; main carries them too
# so the user-facing agent can read what they do).
for profile in "${PROFILES[@]}"; do
    SKILLS_DST="$HERMES_DATA_DIR/profiles/$profile/skills"
    for skill in vault-curator vault-janitor vault-distiller; do
        SRC_HASH=$(find "$SKILLS_SRC_DIR/$skill" -type f -exec md5sum {} \; | sort | md5sum | cut -d' ' -f1)
        HASH_FILE="$SKILLS_DST/$skill/.content-hash"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
            echo "[init] Skill $skill unchanged in $profile, skipping"
        else
            rm -rf "${SKILLS_DST:?}/$skill"
            cp -r "$SKILLS_SRC_DIR/$skill" "$SKILLS_DST/$skill"
            echo "$SRC_HASH" > "$HASH_FILE"
            echo "[init] Skill $skill deployed to $profile"
        fi
    done
done

# --- 2b. Platform-native main-agent skills -----------------------------------
# Teach the user-facing Alfred how to use its MCP tools. The
# alfred-prime-federation skill is Prime-only.
MAIN_SKILLS_SRC="/setup/workspace-template/skills"
if [[ -d "$MAIN_SKILLS_SRC" ]]; then
    for profile in "${PROFILES[@]}"; do
        SKILLS_DST="$HERMES_DATA_DIR/profiles/$profile/skills"
        for skill_dir in "$MAIN_SKILLS_SRC"/*/; do
            [[ -d "$skill_dir" ]] || continue
            skill=$(basename "$skill_dir")

            # Gate the Prime-only federation skill.
            if [[ "$skill" == "alfred-prime-federation" && "${ALFRED_PRIME:-}" != "true" ]]; then
                if [[ -d "$SKILLS_DST/$skill" ]]; then
                    rm -rf "${SKILLS_DST:?}/$skill"
                    echo "[init] Main skill $skill removed from $profile (not Alfred Prime)"
                fi
                continue
            fi

            SRC_HASH=$(find "$skill_dir" -type f -exec md5sum {} \; | sort | md5sum | cut -d' ' -f1)
            HASH_FILE="$SKILLS_DST/$skill/.content-hash"
            if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
                echo "[init] Main skill $skill unchanged in $profile, skipping"
            else
                rm -rf "${SKILLS_DST:?}/$skill"
                cp -r "$skill_dir" "$SKILLS_DST/$skill"
                echo "$SRC_HASH" > "$HASH_FILE"
                echo "[init] Main skill $skill deployed to $profile"
            fi
        done
    done
fi

# --- 2c. Canonical workspace TOOLS.md ----------------------------------------
WORKSPACE_DOCS_SRC="/setup/workspace-template/docs/TOOLS.md"
if [[ -f "$WORKSPACE_DOCS_SRC" ]]; then
    SRC_HASH=$(md5sum "$WORKSPACE_DOCS_SRC" | cut -d' ' -f1)
    for profile in "${PROFILES[@]}"; do
        WS_DIR="$HERMES_DATA_DIR/profiles/$profile/workspace"
        mkdir -p "$WS_DIR"
        HASH_FILE="$WS_DIR/.TOOLS.md.content-hash"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
            echo "[init] TOOLS.md unchanged in $profile, skipping"
        else
            cp "$WORKSPACE_DOCS_SRC" "$WS_DIR/TOOLS.md"
            echo "$SRC_HASH" > "$HASH_FILE"
            echo "[init] TOOLS.md installed in $profile"
        fi
    done
fi

# --- 2d. ctrl-server.mjs MCP server ------------------------------------------
MCP_SRC="/setup/mcp/ctrl-server.mjs"
if [[ -f "$MCP_SRC" ]]; then
    SRC_HASH=$(md5sum "$MCP_SRC" | cut -d' ' -f1)
    for profile in "${PROFILES[@]}"; do
        MCP_DST="$HERMES_DATA_DIR/profiles/$profile/mcp"
        mkdir -p "$MCP_DST"
        HASH_FILE="$MCP_DST/.ctrl-server.content-hash"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
            echo "[init] MCP ctrl-server unchanged in $profile, skipping"
        else
            cp "$MCP_SRC" "$MCP_DST/ctrl-server.mjs"
            echo "$SRC_HASH" > "$HASH_FILE"
            echo "[init] MCP ctrl-server deployed to $profile"
        fi
    done
fi

# --- 2e. 5-app stdio MCP bundle ----------------------------------------------
MCP_STDIO_SRC="/setup/mcp-stdio"
if [[ -d "$MCP_STDIO_SRC" ]]; then
    BUNDLE_HASH=$(find "$MCP_STDIO_SRC" -type f -not -name '.*' \
        -exec md5sum {} \; | sort | md5sum | cut -d' ' -f1)
    for profile in "${PROFILES[@]}"; do
        MCP_STDIO_DST="$HERMES_DATA_DIR/profiles/$profile/mcp-stdio"
        HASH_FILE="$HERMES_DATA_DIR/profiles/$profile/.mcp-stdio.content-hash"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$BUNDLE_HASH" ]]; then
            echo "[init] MCP stdio bundle unchanged in $profile, skipping"
        else
            mkdir -p "$MCP_STDIO_DST"
            rsync -a --delete "$MCP_STDIO_SRC/" "$MCP_STDIO_DST/"
            echo "$BUNDLE_HASH" > "$HASH_FILE"
            echo "[init] MCP stdio bundle deployed to $profile"
        fi
    done
fi

# --- 2f. AGENTS.md -----------------------------------------------------------
AGENTS_SRC="/setup/AGENTS.md"
if [[ -f "$AGENTS_SRC" ]]; then
    AGENTS_HASH=$(md5sum "$AGENTS_SRC" | cut -d' ' -f1)
    for profile in "${PROFILES[@]}"; do
        PROFILE_DIR="$HERMES_DATA_DIR/profiles/$profile"
        HASH_FILE="$PROFILE_DIR/.agents-md.content-hash"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$AGENTS_HASH" ]]; then
            echo "[init] AGENTS.md unchanged in $profile, skipping"
        else
            cp "$AGENTS_SRC" "$PROFILE_DIR/AGENTS.md"
            echo "$AGENTS_HASH" > "$HASH_FILE"
            echo "[init] AGENTS.md deployed to $profile"
        fi
    done
fi

# =============================================================================
# 3. Generate the alfred vault-daemon config.yaml.
# =============================================================================
if [[ ! -f /alfred-data/config.yaml ]]; then
    echo "[init] Generating alfred config.yaml..."
    export VAULT_PATH="/vault"
    # The alfred vault daemon reaches the runtime via the hermes-shim, which
    # preserves the OpenClaw wrapper contract. The wrapper path is unchanged;
    # only the gateway behind it changed.
    export OPENCLAW_WRAPPER_PATH="/usr/local/bin/openclaw-wrapper"
    export DATA_DIR="/app/data"
    envsubst < ./config.yaml.tpl > /alfred-data/config.yaml
    echo "[init] alfred config.yaml written"
else
    echo "[init] alfred config.yaml exists, preserving user edits"
fi

# Note: the Ollama embedding model (nomic-embed-text) is auto-pulled by the
# ollama service itself at startup. Idempotent.

# =============================================================================
# 4. Generate the gateway token.
#
# token_urlsafe(32) → /alfred-data/.gateway-token. This single value is:
#   - the bearer token every legacy caller already presents (the hermes-shim
#     validates inbound /tools/invoke requests against it),
#   - rendered into each Hermes profile's .env as API_SERVER_KEY (step 6).
# =============================================================================
TOKEN_FILE="/alfred-data/.gateway-token"
if [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    echo "${OPENCLAW_GATEWAY_TOKEN}" > "$TOKEN_FILE"
    echo "[init] Using provided gateway token"
elif [[ ! -f "$TOKEN_FILE" ]]; then
    TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
    echo "$TOKEN" > "$TOKEN_FILE"
    echo "[init] Generated gateway token"
else
    echo "[init] Using existing gateway token"
fi
chmod 600 "$TOKEN_FILE" 2>/dev/null || true
GATEWAY_TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")

# =============================================================================
# 5. Initialize the intuition index.
# =============================================================================
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

# =============================================================================
# 6. Render the per-profile Hermes config.yaml + .env.
#
# REPLACES the deleted OpenClaw steps:
#   - openclaw.json gateway-token sync
#   - openclaw.json allowlist / stateless-agent surgery
#   - the .jsonl session-reset loop
#
# render_hermes.py renders hermes-config.yaml.njk + hermes-profile.env.njk
# for each profile. It WRITES through this container's mount
# ($HERMES_DATA_DIR) but BAKES the runtime view ($HERMES_RUNTIME_HOME)
# into the absolute paths inside config.yaml. The token becomes
# API_SERVER_KEY in each .env.
# =============================================================================
echo "[init] Rendering Hermes profile configs..."
for profile in "${PROFILES[@]}"; do
    INIT_PROFILE_DIR="$HERMES_DATA_DIR/profiles/$profile"
    RUNTIME_PROFILE_DIR="$HERMES_RUNTIME_HOME/profiles/$profile"
    mkdir -p "$INIT_PROFILE_DIR"

    HERMES_VAULT_PATH="/vault" \
    HERMES_RUNTIME_PROFILE_DIR="$RUNTIME_PROFILE_DIR" \
        python3 /setup/render_hermes.py \
            "$profile" \
            "$INIT_PROFILE_DIR" \
            /setup \
            "$GATEWAY_TOKEN"
    echo "[init] Rendered Hermes profile: $profile"
done

# =============================================================================
# 7. Permissions.
#
# The Hermes runtime container runs as uid 10000 (the `hermes` user). Its
# entrypoint can usermod/chown the volume, but pre-chowning here avoids a
# first-boot ownership race on the profile configs the runtime must read.
# =============================================================================
chown -R 10000:10000 "$HERMES_DATA_DIR" 2>/dev/null || true
chown -R 10000:10000 /vault 2>/dev/null || true

mkdir -p /alfred-data
chmod -R 777 /alfred-data 2>/dev/null || true
# Re-tighten the token after the broad chmod — it must not be world-readable.
chmod 600 "$TOKEN_FILE" 2>/dev/null || true

# Chore-system directories — pre-created so the loaders never log a
# spurious "directory not found" on a fresh VM.
mkdir -p /alfred-data/user-chores /alfred-data/chore-snapshots
chmod 777 /alfred-data/user-chores /alfred-data/chore-snapshots 2>/dev/null || true

# =============================================================================
# 8. Backfill COMPOSIO_USER_ID.
# =============================================================================
COMPOSIO_UID_FILE=/alfred-data/.composio-user-id
EXISTING_UID=""
if [[ -f "$COMPOSIO_UID_FILE" ]]; then
    EXISTING_UID=$(tr -d '[:space:]' < "$COMPOSIO_UID_FILE")
fi
ENV_UID="${COMPOSIO_USER_ID:-}"
if [[ -n "$ENV_UID" && "$ENV_UID" != "default" ]]; then
    if [[ "$EXISTING_UID" != "$ENV_UID" ]]; then
        echo -n "$ENV_UID" > "$COMPOSIO_UID_FILE"
        echo "[init] Mirrored COMPOSIO_USER_ID=$ENV_UID to $COMPOSIO_UID_FILE"
    else
        echo "[init] COMPOSIO_USER_ID already mirrored"
    fi
elif [[ -n "$EXISTING_UID" && "$EXISTING_UID" != "default" ]]; then
    echo "[init] COMPOSIO_USER_ID backfill file already present ($EXISTING_UID)"
else
    echo "[init] COMPOSIO_USER_ID not set — Composio per-user isolation disabled."
    echo "[init]   Set COMPOSIO_USER_ID in .env to enable. (Composio is optional.)"
fi
chmod 644 "$COMPOSIO_UID_FILE" 2>/dev/null || true

# =============================================================================
# 9. Seed the email channel's authorized-senders list.
# =============================================================================
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
fi

# =============================================================================
# 10. Stage the Sure (sure.am) first-boot bootstrap inputs.
#
# Unchanged from the OpenClaw init — Sure is an optional Rails sidecar; the
# actual API-key mint runs in the separate `sure-init` compose service.
# Init's job is to stage the inputs that one-shot needs.
# =============================================================================
if [[ "${SURE_ENABLED:-false}" != "true" ]]; then
    echo "[init] SURE_ENABLED!=true, skipping Sure bootstrap staging."
else
    if [[ -z "${OWNER_EMAIL:-}" ]]; then
        echo "[init] ACTION REQUIRED: SURE_ENABLED=true but OWNER_EMAIL is unset."
        echo "[init]   Cannot stage Sure bootstrap without an admin email."
    else
        SURE_EMAIL_FILE=/alfred-data/.sure-bootstrap-email
        SURE_PW_FILE=/alfred-data/.sure-bootstrap-password
        SURE_SCRIPT_DIR=/alfred-data/sure-bootstrap
        SURE_SCRIPT_DST="$SURE_SCRIPT_DIR/bootstrap.rb"
        SURE_SCRIPT_SRC=/setup/sure-bootstrap.rb

        OWNER_EMAIL_LOWER=$(echo "$OWNER_EMAIL" | tr '[:upper:]' '[:lower:]')
        echo -n "$OWNER_EMAIL_LOWER" > "$SURE_EMAIL_FILE"
        chmod 644 "$SURE_EMAIL_FILE" 2>/dev/null || true

        if [[ ! -f "$SURE_PW_FILE" || ! -s "$SURE_PW_FILE" ]]; then
            SURE_PW=$(python3 -c "import secrets; print(secrets.token_urlsafe(24) + '!Aa1')")
            printf '%s' "$SURE_PW" > "$SURE_PW_FILE"
            chmod 644 "$SURE_PW_FILE" 2>/dev/null || true
            echo "[init] Generated Sure bootstrap password"
        else
            chmod 644 "$SURE_PW_FILE" 2>/dev/null || true
            echo "[init] Sure bootstrap password already present, reusing"
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
                echo "[init] Deployed Sure bootstrap.rb"
            fi
        else
            echo "[init] WARNING: $SURE_SCRIPT_SRC missing — Sure bootstrap will fail."
        fi

        # Shared library required by every sure-*-mutate.rb via require_relative.
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
                echo "[init] Deployed sure-mutate-base.rb"
            fi
        else
            echo "[init] WARNING: $SURE_BASE_SRC missing — sure-*-mutate.rb scripts will fail."
        fi

        # Mutation scripts — Rails-runner-backed CRUD for surfaces Sure's
        # REST API doesn't expose. All hash-gated, idempotent.
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
                    echo "[init] Deployed $SCRIPT"
                fi
            else
                echo "[init] WARNING: $SURE_MUT_SRC missing — Sure mutation surface will fail."
            fi
        done

        echo "[init] Sure bootstrap staged — the sure-init service will run bootstrap.rb."
    fi
fi

echo "=== Init complete ==="
