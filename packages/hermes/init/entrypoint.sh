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
PROFILES=(main workers heavy)

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
# 1b. Hermes' built-in memory dir — cross-container writable.
#
# Hermes' built-in memory feature reads MEMORY.md + USER.md from
# $HERMES_HOME/memories/. Two containers touch this dir on different uids:
#   - hermes runtime (uid 10000)  → reads the files
#   - alfred-learn  (uid 1000)    → seeds them via personalize_opus
# Without an explicit chmod, mkdir + the later `chown -R 10000:10000` step
# leave this dir hermes-owned 0755 (or worse, root:root 0700 if the chown
# is racy) and alfred-learn's seed silently fails with EACCES — the
# MEMORY.md/USER.md surface stays empty and Hermes runs without the
# personalised memory. 0777 is the simplest portable answer on this
# single-tenant box where the volume is private to the stack, and it
# matches the existing 0777 posture used for /alfred-data and its
# siblings below. Init runs as root and owns the volumes, so chmod here
# is durable — Hermes itself runs non-root and cannot fix this after the
# fact. Live-confirmed regression 2026-05-23.
MEMORIES_DIR="${HERMES_DATA_DIR}/memories"
mkdir -p "$MEMORIES_DIR"
chmod 0777 "$MEMORIES_DIR"
echo "[init] memories dir ready at $MEMORIES_DIR (chmod 0777 for cross-container writes)"

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

# --- 2.0. One-time skill consolidation ---------------------------------------
# Earlier builds of ctrl-api wrote `alfred-composio-<toolkit>/` skill
# folders to `<profile>/workspace/skills/`, while hermes-init wrote the
# platform skill suite (alfred-voice, alfred-connected-apps, …) to
# `<profile>/skills/` — the Hermes-native location that Hermes itself
# reads from. The voice/SMS primer reader matched ctrl-api's path, so the
# composio dirs were visible to the primer but invisible to Hermes, and
# the platform skills the other way around. ctrl-api now writes + reads
# at the Hermes-native location only; this block migrates leftover
# composio dirs from older deployments and removes the empty parallel
# tree so it can never re-divide the catalogue.
for profile in "${PROFILES[@]}"; do
    LEGACY_SKILLS_DIR="$HERMES_DATA_DIR/profiles/$profile/workspace/skills"
    CANONICAL_SKILLS_DIR="$HERMES_DATA_DIR/profiles/$profile/skills"
    if [[ -d "$LEGACY_SKILLS_DIR" ]]; then
        moved=0
        for entry in "$LEGACY_SKILLS_DIR"/*; do
            [[ -e "$entry" ]] || continue
            name=$(basename "$entry")
            if [[ -e "$CANONICAL_SKILLS_DIR/$name" ]]; then
                # Canonical wins — drop the stale duplicate.
                rm -rf "$entry"
            else
                mv "$entry" "$CANONICAL_SKILLS_DIR/$name"
                moved=$((moved + 1))
            fi
        done
        rmdir "$LEGACY_SKILLS_DIR" 2>/dev/null || true
        if [[ "$moved" -gt 0 ]]; then
            echo "[init] Consolidated $moved legacy skill dir(s) into $CANONICAL_SKILLS_DIR ($profile)"
        fi
    fi
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

# --- 2g. SOUL.md — the agent's persona/identity ------------------------------
# Hermes seeds a stock Nous identity ("You are Hermes Agent…") into each
# profile's SOUL.md at first run and never overwrites an existing SOUL. So the
# live agent ran the stock persona, not Alfred. Deploy a personalized SOUL:
#   - SOURCE: the onboarding-chosen persona at /vault/SOUL.md (written by the
#     SoulPresetPage onboarding step) when present + non-empty; else the
#     bundled baseline Alfred SOUL at /setup/SOUL.md.
#   - OVERWRITE GUARD: replace only a MISSING SOUL, the stock Nous SOUL, or
#     one we previously deployed (matched by content-hash). A hand-edited
#     SOUL that is neither stock nor ours is preserved untouched.
SOUL_BUNDLED="/setup/SOUL.md"
SOUL_ONBOARDING="/vault/SOUL.md"
if [[ -s "$SOUL_ONBOARDING" ]]; then
    SOUL_SRC="$SOUL_ONBOARDING"
    echo "[init] Using onboarding-chosen SOUL.md from $SOUL_ONBOARDING"
elif [[ -f "$SOUL_BUNDLED" ]]; then
    SOUL_SRC="$SOUL_BUNDLED"
    echo "[init] Using bundled baseline SOUL.md"
else
    SOUL_SRC=""
    echo "[init] No SOUL.md source available — leaving profile SOUL untouched"
fi
if [[ -n "$SOUL_SRC" ]]; then
    SOUL_HASH=$(md5sum "$SOUL_SRC" | cut -d' ' -f1)
    for profile in "${PROFILES[@]}"; do
        PROFILE_DIR="$HERMES_DATA_DIR/profiles/$profile"
        DST="$PROFILE_DIR/SOUL.md"
        HASH_FILE="$PROFILE_DIR/.soul-md.content-hash"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$SOUL_HASH" ]]; then
            echo "[init] SOUL.md unchanged in $profile, skipping"
        elif [[ -f "$DST" ]] \
            && [[ ! -f "$HASH_FILE" ]] \
            && ! grep -q "You are Hermes Agent" "$DST" 2>/dev/null; then
            # An existing SOUL that is neither the stock Nous identity nor one
            # we deployed (no hash record) — a hand-edit. Do not clobber it.
            echo "[init] SOUL.md in $profile is custom (not stock, not ours) — preserved"
        else
            cp "$SOUL_SRC" "$DST"
            echo "$SOUL_HASH" > "$HASH_FILE"
            echo "[init] SOUL.md deployed to $profile (replacing stock/seed identity)"
        fi
    done
fi

# =============================================================================
# 3. Generate the alfred vault-daemon config.yaml.
# =============================================================================
if [[ ! -f /alfred-data/config.yaml ]]; then
    echo "[init] Generating alfred config.yaml..."
    export VAULT_PATH="/vault"
    # The alfred vault daemon reaches the Hermes runtime directly on its
    # canonical port via the openclaw-wrapper (Hermes `/v1/runs`). The
    # wrapper path is unchanged; only the gateway behind it changed.
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
#   - the bearer token every caller presents to the Hermes /v1 API,
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
# 644, not 600: the token is the shared inter-container bearer for the Hermes
# gateway. ctrl-api runs as root (could read 600) but alfred-learn runs as
# uid 1000 — with 600 root:root, clerk-based signal extraction in alfred-learn
# got "Permission denied: /alfred-data/.gateway-token" and the whole
# stream→signal→decision pipeline died silently (#78). The file lives inside a
# private Docker named volume on a single-owner VM; readable-within-the-stack
# is the correct posture, and it is no looser than its 777 siblings here.
chmod 644 "$TOKEN_FILE" 2>/dev/null || true
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
# 5b. Seed matter/inbox.md — orphan fallback target (sir-fresh-deploy #1).
#
# The packs_opus._resolve_parent_matter_path() helper falls back to
# `matter/inbox.md` when an Opus-emitted `related_matter` is empty or fails
# to slugify into a known matter. The same path is hard-coded as
# `task_creation.DEFAULT_PARENT_MATTER` and is the canonical "orphan home"
# referenced by Steward and the matters aggregator. The comment in
# packs_opus.py at the time of writing said "ctrl-api's task seed scaffolds
# inbox.md if missing" — that was aspirational. Nothing in the stack creates
# it. On a fresh deploy, the first batch of orphan tasks lands on
# `parent_matter: matter/inbox.md` but the file doesn't exist → /matters
# aggregator can't resolve them → 33 tasks went orphan on Sir's tenant
# (2026-05-24) before they were manually relinked.
#
# Schema matches `packages/learn/scripts/migrate_inbox_matter.py`
# `_build_inbox_content()` — the Steward Phase 0 fields are populated so
# the schema migration doesn't need to revisit this record.
#
# Idempotent: only writes when the file is absent. A hand-edited inbox.md
# is preserved untouched.
# =============================================================================
mkdir -p /vault/matter
if [[ ! -f /vault/matter/inbox.md ]]; then
    echo "[init] Seeding matter/inbox.md (orphan fallback target)..."
    CREATED_NOW=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
    cat > /vault/matter/inbox.md <<EOF
---
type: matter
name: "Inbox"
status: active
state: open
surface_class: none
description: "Steward home for orphan tasks."
last_steward_check_at:
last_steward_outcome:
next_check_after: $CREATED_NOW
signal_sources: []
pending_confirmation: false
blocked_on:
staleness_score: 0
created: $CREATED_NOW
created_by: init
---

# Inbox

Steward home for orphan tasks. Tasks land here automatically when they're
created without an explicit \`parent_matter\` (e.g. Opus-emitted errands
whose \`related_matter\` string doesn't slugify into a known matter).

Move them into a real matter by editing \`parent_matter\` on the task —
the matters aggregator will follow the link on the next read.
EOF
    echo "[init] matter/inbox.md seeded"
else
    echo "[init] matter/inbox.md already present, preserving"
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

# --- 6b. Telegram gateway block — INTENTIONALLY UNMANAGED HERE --------------
# Earlier init revisions ran render_telegram_gateway.py to seed a
# `gateway.platforms.telegram` block in main/config.yaml. Live inspection
# (2026-05-25) showed Hermes' running gateway reads platform secrets
# directly from the per-profile $HERMES_HOME/profiles/main/.env file
# (TELEGRAM_BOT_TOKEN/TELEGRAM_ALLOWED_USERS/TELEGRAM_HOME_CHANNEL) and
# its channel_directory.json — config.yaml's platforms block is unused on
# the live build. Sir's bot works with `platforms: {}` in config.yaml.
# Telegram configuration is therefore owned by `ctrl-api`'s PUT
# /api/v1/channels/telegram/token, which writes the per-profile .env via
# `docker exec` and bounces the gateway. No init-time step required.

# --- 6c. SMS gateway block — MUST BE MANAGED HERE ---------------------------
# Unlike Telegram, Hermes' SMS adapter (`gateway/platforms/sms.py`) is
# strictly opt-in: it only starts its webhook listener when config.yaml
# carries a `gateway.platforms.sms` block with `enabled: true` AND the
# Twilio env vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
# `TWILIO_PHONE_NUMBER`) are populated in the per-profile .env. The
# template-baked block (hermes-config.yaml.njk) only lands on a FIRST
# seed; an already-existing operator-owned config.yaml is preserved by
# `render_hermes.py` and would never receive the new block. This step is
# an idempotent ADD-only mutator that backfills the block whenever it's
# missing, leaving any operator-set state (incl. `enabled: false`)
# untouched.
MAIN_PROFILE_DIR="$HERMES_DATA_DIR/profiles/main"
if [[ -f "$MAIN_PROFILE_DIR/config.yaml" ]]; then
    MAIN_PROFILE_DIR="$MAIN_PROFILE_DIR" \
        python3 /setup/render_sms_gateway.py
fi

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
# Keep the token readable by every service in the stack (alfred-learn is
# uid 1000 and needs it for clerk → Hermes gateway auth, #78). 644 is the
# tightest mode that still lets a non-root sibling read it.
chmod 644 "$TOKEN_FILE" 2>/dev/null || true

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
# Sure runs in the default compose stack, so default SURE_ENABLED on.
if [[ "${SURE_ENABLED:-true}" != "true" ]]; then
    echo "[init] SURE_ENABLED!=true, skipping Sure bootstrap staging."
else
    # Fall back to ACME_EMAIL — every deploy provides one, so Sure staging
    # works without the deployer setting a separate OWNER_EMAIL.
    OWNER_EMAIL="${OWNER_EMAIL:-${ACME_EMAIL:-}}"
    if [[ -z "${OWNER_EMAIL:-}" ]]; then
        echo "[init] ACTION REQUIRED: SURE_ENABLED=true but OWNER_EMAIL/ACME_EMAIL is unset."
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

# =============================================================================
# 11. Stage the Plane first-boot admin bootstrap inputs (Sir #6, 2026-05-24).
# Mirrors the Sure pattern: alfred-init stages email + generated password,
# the separate `plane-init` one-shot service runs plane-bootstrap.py.
# =============================================================================
if [[ "${PLANE_ENABLED:-true}" != "true" ]]; then
    echo "[init] PLANE_ENABLED!=true, skipping Plane bootstrap staging."
else
    OWNER_EMAIL="${OWNER_EMAIL:-${ACME_EMAIL:-}}"
    if [[ -z "${OWNER_EMAIL:-}" ]]; then
        echo "[init] ACTION REQUIRED: PLANE_ENABLED=true but OWNER_EMAIL/ACME_EMAIL is unset."
        echo "[init]   Cannot stage Plane bootstrap without an admin email."
    else
        PLANE_EMAIL_FILE=/alfred-data/.plane-bootstrap-email
        PLANE_PW_FILE=/alfred-data/.plane-bootstrap-password
        PLANE_PW_DONE=/alfred-data/.plane-admin-password

        OWNER_EMAIL_LOWER=$(echo "$OWNER_EMAIL" | tr '[:upper:]' '[:lower:]')
        echo -n "$OWNER_EMAIL_LOWER" > "$PLANE_EMAIL_FILE"
        chmod 644 "$PLANE_EMAIL_FILE" 2>/dev/null || true

        # Skip password (re)generation if we've already finalized one — the
        # done-file is only present after plane-init confirms is_setup_done.
        if [[ -f "$PLANE_PW_DONE" && -s "$PLANE_PW_DONE" ]]; then
            echo "[init] Plane admin already seeded, password preserved at $PLANE_PW_DONE"
        elif [[ ! -f "$PLANE_PW_FILE" || ! -s "$PLANE_PW_FILE" ]]; then
            # Plane requires zxcvbn score >= 3 — token_urlsafe(24)+suffix
            # passes comfortably (high entropy, mixed classes).
            PLANE_PW=$(python3 -c "import secrets; print(secrets.token_urlsafe(24) + '!Aa1')")
            printf '%s' "$PLANE_PW" > "$PLANE_PW_FILE"
            chmod 644 "$PLANE_PW_FILE" 2>/dev/null || true
            echo "[init] Generated Plane bootstrap password"
        else
            chmod 644 "$PLANE_PW_FILE" 2>/dev/null || true
            echo "[init] Plane bootstrap password already present, reusing"
        fi

        PLANE_SCRIPT_DIR=/alfred-data/plane-bootstrap
        PLANE_SCRIPT_DST="$PLANE_SCRIPT_DIR/plane-bootstrap.py"
        PLANE_SCRIPT_SRC=/setup/plane-bootstrap.py
        if [[ -f "$PLANE_SCRIPT_SRC" ]]; then
            mkdir -p "$PLANE_SCRIPT_DIR"
            PLANE_SRC_HASH=$(md5sum "$PLANE_SCRIPT_SRC" | cut -d' ' -f1)
            PLANE_HASH_FILE="$PLANE_SCRIPT_DIR/.plane-bootstrap.py.content-hash"
            if [[ -f "$PLANE_HASH_FILE" && "$(cat "$PLANE_HASH_FILE")" == "$PLANE_SRC_HASH" && -f "$PLANE_SCRIPT_DST" ]]; then
                echo "[init] plane-bootstrap.py unchanged, skipping copy"
            else
                cp "$PLANE_SCRIPT_SRC" "$PLANE_SCRIPT_DST"
                echo "$PLANE_SRC_HASH" > "$PLANE_HASH_FILE"
                chmod 644 "$PLANE_SCRIPT_DST" 2>/dev/null || true
                echo "[init] Deployed plane-bootstrap.py"
            fi
        else
            echo "[init] WARNING: $PLANE_SCRIPT_SRC missing — Plane admin auto-seed will fail."
        fi

        echo "[init] Plane bootstrap staged — the plane-init service will run plane-bootstrap.py."
    fi
fi

echo "=== Init complete ==="
