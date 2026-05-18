#!/usr/bin/env bash
# import-files.sh — read a fixed list of file-on-disk secrets and create
# Vaultwarden items for each so they're visible in the web UI alongside
# the .env-derived items.
#
# These files are NOT in /opt/alfred/compose/.env (and shouldn't be — they're
# bootstrap state generated at first-boot and consumed by direct file read,
# not env_file injection). But Sir wants them findable in the Vaultwarden
# web UI for support / break-glass scenarios:
#
#   /alfred-data/.gateway-token            → OPENCLAW_GATEWAY_TOKEN
#   /alfred-data/.sure-bootstrap-email     → SURE_ADMIN_EMAIL
#   /alfred-data/.sure-bootstrap-password  → SURE_ADMIN_PASSWORD
#
# Plus the three Vexa bootstrap secrets when /opt/alfred/vexa/.env exists
# (Steward Phase 4 — only created on tenants where setupVexa has run; the
# script skips cleanly otherwise). These live in a SEPARATE .env file
# (the standalone vexa compose project's env), not in the alfred .env:
#
#   $VEXA_ENV_PATH (default /host/vexa/.env)
#     ADMIN_API_TOKEN              → Vexa Admin
#     VEXA_API_KEY                 → Vexa API Key
#     VEXA_WEBHOOK_SECRET          → Vexa Webhook Secret
#
# This script does NOT make Vaultwarden the source of truth for these — the
# files on disk are still authoritative. It just snapshots them. If a value
# is rotated on disk and this script is re-run, the existing Vaultwarden
# item is updated in-place (idempotent). Run from `vault-cli` or any
# vault-init instance with the bootstrap env vars set.
#
# Inputs:
#   BW_USER, BW_PASSWORD, BW_SERVER_URL — same shape as the other vault-init
#                                          scripts.
#   ALFRED_DATA_PATH                   — defaults to /alfred-data; override
#                                          for testing.
set -eo pipefail

DATA_DIR="${ALFRED_DATA_PATH:-/alfred-data}"

log() { echo "[import-files] $*" >&2; }
fatal() { log "FATAL: $*"; exit 3; }

[ -n "$BW_USER" ]       || fatal "BW_USER unset"
[ -n "$BW_PASSWORD" ]   || fatal "BW_PASSWORD unset"
[ -n "$BW_SERVER_URL" ] || fatal "BW_SERVER_URL unset"
[ -d "$DATA_DIR" ]      || fatal "$DATA_DIR not mounted"

log "Configuring bw → $BW_SERVER_URL"
bw config server "$BW_SERVER_URL" >/dev/null

LOGIN_ERR=$(mktemp)
LOGIN_OUT=$(bw login "$BW_USER" "$BW_PASSWORD" --raw </dev/null 2>"$LOGIN_ERR") || LOGIN_RC=$?
LOGIN_RC=${LOGIN_RC:-0}
if [ "$LOGIN_RC" -ne 0 ]; then
  if grep -q "already logged in" "$LOGIN_ERR"; then
    LOGIN_OUT=$(bw unlock "$BW_PASSWORD" --raw </dev/null 2>"$LOGIN_ERR") || fatal "bw unlock failed: $(cat "$LOGIN_ERR")"
  else
    fatal "bw login failed: $(cat "$LOGIN_ERR")"
  fi
fi
rm -f "$LOGIN_ERR"
export BW_SESSION="$LOGIN_OUT"

log "Syncing"
bw sync --session "$BW_SESSION" </dev/null >/dev/null

# Build a name → id map of existing items for in-place updates.
ITEMS_JSON=$(bw list items --session "$BW_SESSION" </dev/null 2>/dev/null)

# Args: name, value, notes
upsert_item() {
  local name="$1"
  local value="$2"
  local notes="$3"

  if [ -z "$value" ]; then
    log "skip $name (empty value)"
    return 0
  fi

  local existing_id
  existing_id=$(echo "$ITEMS_JSON" | jq -r --arg n "$name" '.[] | select(.name == $n) | .id' | head -n1)

  local item_json
  item_json=$(jq -n \
    --arg name "$name" \
    --arg pw "$value" \
    --arg notes "$notes" \
    '{
      type: 1,
      name: $name,
      notes: $notes,
      login: { username: null, password: $pw, uris: [] }
    }')
  local item_b64
  item_b64=$(printf '%s' "$item_json" | base64 | tr -d '\n')

  if [ -n "$existing_id" ]; then
    if bw edit item "$existing_id" "$item_b64" --session "$BW_SESSION" </dev/null >/dev/null 2>&1; then
      log "~ $name (updated existing $existing_id)"
    else
      log "FAILED to update $name (id $existing_id)"
    fi
  else
    if bw create item "$item_b64" --session "$BW_SESSION" </dev/null >/dev/null 2>&1; then
      log "+ $name (created)"
    else
      log "FAILED to create $name"
    fi
  fi
}

# 1. OpenClaw gateway token. The env-var name OPENCLAW_GATEWAY_TOKEN_FILE
# points at this file on every running container; we store the *value* in
# Vaultwarden under a clean name so the web UI surfaces it directly.
gateway_token_file="$DATA_DIR/.gateway-token"
if [ -r "$gateway_token_file" ]; then
  gateway_token=$(tr -d '\r\n' < "$gateway_token_file")
  upsert_item \
    "OPENCLAW_GATEWAY_TOKEN" \
    "$gateway_token" \
    "Source of truth: $gateway_token_file on the tenant VPS. This Vaultwarden item is a snapshot for visibility — runtime services still read the file directly (env var OPENCLAW_GATEWAY_TOKEN_FILE points there). Re-run import-files.sh after rotation to refresh."
else
  log "skip OPENCLAW_GATEWAY_TOKEN ($gateway_token_file not readable)"
fi

# 2. Sure admin email
sure_email_file="$DATA_DIR/.sure-bootstrap-email"
if [ -r "$sure_email_file" ]; then
  sure_email=$(tr -d '\r\n' < "$sure_email_file")
  upsert_item \
    "SURE_ADMIN_EMAIL" \
    "$sure_email" \
    "Sure web UI admin login email. Source of truth: $sure_email_file. Used to log in at https://<subdomain>-sure.<domain>."
else
  log "skip SURE_ADMIN_EMAIL ($sure_email_file not readable)"
fi

# 3. Sure admin password
sure_password_file="$DATA_DIR/.sure-bootstrap-password"
if [ -r "$sure_password_file" ]; then
  sure_password=$(tr -d '\r\n' < "$sure_password_file")
  upsert_item \
    "SURE_ADMIN_PASSWORD" \
    "$sure_password" \
    "Sure web UI admin login password. Source of truth: $sure_password_file (mode 0600 on tenant VPS). Generated by sure-bootstrap.rb on first boot; static thereafter. Pair with SURE_ADMIN_EMAIL."
else
  log "skip SURE_ADMIN_PASSWORD ($sure_password_file not readable)"
fi

# --- Vexa secrets (Steward Phase 4) ---
#
# These come from /opt/alfred/vexa/.env, NOT /opt/alfred/compose/.env.
# That file only exists on tenants where setupVexa has run; on every
# other tenant the entire block skips silently.
#
# Source of truth precedence:
#   1. Container env (VEXA_ADMIN_API_TOKEN / VEXA_API_KEY /
#      VEXA_WEBHOOK_SECRET) — set by docker compose run --env on the
#      provisioner side. Lets the provisioner force-refresh after
#      rotation without going through the file.
#   2. The vexa .env file at $VEXA_ENV_PATH (default /host/vexa/.env)
#      via the same key names Vexa expects (ADMIN_API_TOKEN). The
#      provisioner mounts /opt/alfred/vexa as /host/vexa:ro for the
#      vault-init oneshot.
VEXA_ENV_PATH="${VEXA_ENV_PATH:-/host/vexa/.env}"

# Read a value from the vexa .env. Strips optional surrounding single
# quotes (matches the writeTenantEnv quoting in env-write.ts).
read_vexa_env() {
  local key="$1"
  if [ ! -f "$VEXA_ENV_PATH" ]; then return 1; fi
  local line
  line=$(grep -E "^${key}=" "$VEXA_ENV_PATH" | tail -n1)
  if [ -z "$line" ]; then return 1; fi
  local val="${line#${key}=}"
  if [[ "$val" == \'*\' && "${#val}" -ge 2 ]]; then
    val="${val:1:${#val}-2}"
  fi
  printf '%s' "$val"
}

# 4. Vexa admin API token. Used to manage users + tokens via the
# admin-api endpoint. Stored under VEXA_ADMIN_API_TOKEN even though Vexa
# upstream calls it ADMIN_API_TOKEN — namespaced to make Vaultwarden
# search disambiguate it from any other ADMIN_API_TOKEN.
vexa_admin_token="${VEXA_ADMIN_API_TOKEN:-}"
if [ -z "$vexa_admin_token" ]; then
  vexa_admin_token=$(read_vexa_env ADMIN_API_TOKEN || echo "")
fi
if [ -n "$vexa_admin_token" ]; then
  upsert_item \
    "VEXA_ADMIN_API_TOKEN" \
    "$vexa_admin_token" \
    "Vexa admin API token. Source of truth: ADMIN_API_TOKEN in $VEXA_ENV_PATH on the tenant VPS. Use with header X-Admin-API-Key against http://vexa-admin-api:8001/admin/* (or the api-gateway proxy at /admin/*). Re-run import-files.sh after rotation."
else
  log "skip VEXA_ADMIN_API_TOKEN (no value in env, no $VEXA_ENV_PATH, or key absent)"
fi

# 5. Vexa user-scoped API key. This is what alfred-learn passes as
# X-API-Key when scheduling bots and registering webhooks. Generated by
# the provisioner via POST /admin/users → POST /admin/users/<id>/tokens.
vexa_api_key="${VEXA_API_KEY:-}"
if [ -z "$vexa_api_key" ]; then
  vexa_api_key=$(read_vexa_env VEXA_API_KEY || echo "")
fi
if [ -n "$vexa_api_key" ]; then
  upsert_item \
    "VEXA_API_KEY" \
    "$vexa_api_key" \
    "Vexa user-scoped API key — header X-API-Key against http://vexa-api-gateway:8000. Used by alfred-learn to schedule bots and register the meeting.completed webhook. Source of truth: VEXA_API_KEY in /opt/alfred/compose/.env (consumed by alfred-learn) — also written into $VEXA_ENV_PATH for cross-stack reference."
else
  log "skip VEXA_API_KEY (not set in env or $VEXA_ENV_PATH)"
fi

# 6. Vexa webhook signing secret. Vexa HMACs the meeting.completed
# webhook body with this secret; ctrl-api's /api/v1/webhooks/vexa route
# verifies the signature before trusting the payload.
vexa_webhook_secret="${VEXA_WEBHOOK_SECRET:-}"
if [ -z "$vexa_webhook_secret" ]; then
  vexa_webhook_secret=$(read_vexa_env VEXA_WEBHOOK_SECRET || echo "")
fi
if [ -n "$vexa_webhook_secret" ]; then
  upsert_item \
    "VEXA_WEBHOOK_SECRET" \
    "$vexa_webhook_secret" \
    "Vexa webhook signing secret. Vexa HMACs meeting.completed payloads with this; ctrl-api verifies the X-Vexa-Signature header against it before processing. Source of truth: $VEXA_ENV_PATH on the tenant VPS — also mirrored to /opt/alfred/compose/.env for ctrl-api."
else
  log "skip VEXA_WEBHOOK_SECRET (not set in env or $VEXA_ENV_PATH)"
fi

log "import-files.sh done"
