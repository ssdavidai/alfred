#!/usr/bin/env bash
# import-logins.sh — create combined Bitwarden login items for the apps Sir
# logs into through a browser (Sure, Plane, Vaultwarden itself). Without
# this, Sir's vault has separate SURE_ADMIN_EMAIL + SURE_ADMIN_PASSWORD
# items that don't auto-fill on the login page — Vaultwarden's autofill
# triggers on a single item with `login.username` + `login.password` +
# `login.uris[].uri` matching the page's domain.
#
# This script is COMPLEMENTARY to migrate.sh + import-files.sh. Those
# scripts maintain the env-var-name → value mapping used by vault-init
# to round-trip secrets back into .env. This one creates ADDITIONAL items
# with human names + URIs so Vaultwarden's browser extension and web vault
# autofill work correctly. The new items don't override the env-var-name
# items (which still exist for vault-init's round-trip).
#
# Items created (idempotent, upsert by item name):
#
#   "Sure" — uri=https://<sub>-sure.<domain>
#            username = SURE_ADMIN_EMAIL (from /alfred-data/.sure-bootstrap-email)
#            password = SURE_ADMIN_PASSWORD (from /alfred-data/.sure-bootstrap-password)
#
#   "Plane" — uri=https://<sub>-plane.<domain>
#             username = PLANE_ADMIN_EMAIL (from .env)
#             password = PLANE_ADMIN_PASSWORD (from .env)
#
#   "Vaultwarden" — uri=https://<sub>-vault.<domain>
#                   username = BW_USER (from .env)
#                   password = BW_PASSWORD (from .env)
#
#   "Vexa" — uri=https://<sub>-vexa.<domain>
#            username = ALFRED_OWNER_EMAIL (from .env, fallback BW_USER)
#            password = VEXA_ADMIN_API_TOKEN (from /host/vexa/.env)
#            (only created when /host/vexa/.env is mounted and the
#            ADMIN_API_TOKEN key is present — i.e. setupVexa ran on
#            this tenant; skipped silently otherwise.)
#
# Inputs:
#   BW_USER, BW_PASSWORD, BW_SERVER_URL — same shape other vault-init scripts use
#   TENANT_SUBDOMAIN, TENANT_DOMAIN     — for building the URIs (typically read
#                                          from .env via env_file in compose)
#   ALFRED_DATA_PATH                    — defaults to /alfred-data
#   COMPOSE_ENV_PATH                    — defaults to /host/compose/.env
set -eo pipefail

DATA_DIR="${ALFRED_DATA_PATH:-/alfred-data}"
ENV_PATH="${COMPOSE_ENV_PATH:-/host/compose/.env}"
SUBDOMAIN="${TENANT_SUBDOMAIN:-}"
DOMAIN="${TENANT_DOMAIN:-alfred.black}"

log() { echo "[import-logins] $*" >&2; }
fatal() { log "FATAL: $*"; exit 3; }

[ -n "$BW_USER" ]       || fatal "BW_USER unset"
[ -n "$BW_PASSWORD" ]   || fatal "BW_PASSWORD unset"
[ -n "$BW_SERVER_URL" ] || fatal "BW_SERVER_URL unset"
[ -n "$SUBDOMAIN" ]     || fatal "TENANT_SUBDOMAIN unset (need it to build login URIs)"

# Read a value from /host/compose/.env. Strips optional surrounding single
# quotes (writeTenantEnv wraps values).
read_env() {
  local key="$1"
  if [ ! -f "$ENV_PATH" ]; then return 1; fi
  local line
  line=$(grep -E "^${key}=" "$ENV_PATH" | tail -n1)
  if [ -z "$line" ]; then return 1; fi
  local val="${line#${key}=}"
  if [[ "$val" == \'*\' && "${#val}" -ge 2 ]]; then
    val="${val:1:${#val}-2}"
  fi
  printf '%s' "$val"
}

# Read a single-line file; trim CR + LF.
read_file() {
  local path="$1"
  if [ ! -r "$path" ]; then return 1; fi
  tr -d '\r\n' < "$path"
}

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

# Build name → id map of existing items for in-place updates.
ITEMS_JSON=$(bw list items --session "$BW_SESSION" </dev/null 2>/dev/null)

# Args: name, username, password, uri
upsert_login() {
  local name="$1"
  local username="$2"
  local password="$3"
  local uri="$4"

  if [ -z "$username" ] || [ -z "$password" ]; then
    log "skip $name (missing username or password)"
    return 0
  fi

  local existing_id
  existing_id=$(echo "$ITEMS_JSON" | jq -r --arg n "$name" '.[] | select(.name == $n) | .id' | head -n1)

  local item_json
  item_json=$(jq -n \
    --arg name "$name" \
    --arg u "$username" \
    --arg p "$password" \
    --arg uri "$uri" \
    --arg notes "Browser-autofill login for the $name web UI on this tenant. Auto-created by import-logins.sh; safe to edit URI/notes in the web UI." \
    '{
      type: 1,
      name: $name,
      notes: $notes,
      login: {
        username: $u,
        password: $p,
        uris: [{ uri: $uri, match: null }]
      }
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

# 1. Sure — combine .sure-bootstrap-email + .sure-bootstrap-password
sure_email=$(read_file "$DATA_DIR/.sure-bootstrap-email" || read_env OWNER_EMAIL || echo "")
sure_password=$(read_file "$DATA_DIR/.sure-bootstrap-password" || echo "")
upsert_login \
  "Sure" \
  "$sure_email" \
  "$sure_password" \
  "https://${SUBDOMAIN}-sure.${DOMAIN}"

# 2. Plane — combine PLANE_ADMIN_EMAIL + PLANE_ADMIN_PASSWORD from .env
plane_email=$(read_env PLANE_ADMIN_EMAIL || echo "")
plane_password=$(read_env PLANE_ADMIN_PASSWORD || echo "")
upsert_login \
  "Plane" \
  "$plane_email" \
  "$plane_password" \
  "https://${SUBDOMAIN}-plane.${DOMAIN}"

# 3. Vaultwarden — self-reference. BW_USER + BW_PASSWORD are already in our
# bootstrap env, so re-using them. Useful when Sir is logged out and wants
# the browser extension to suggest credentials on the Vaultwarden login page.
upsert_login \
  "Vaultwarden" \
  "$BW_USER" \
  "$BW_PASSWORD" \
  "https://${SUBDOMAIN}-vault.${DOMAIN}"

# 4. Vexa — synapsr/vexa-dashboard signs the user in by email. The Vexa
# admin API token doubles as the password for the admin login surface,
# but the dashboard itself runs in direct-login mode (ALLOW_REGISTRATIONS
# is false; see vexa-stack.yaml.njk). Sir's email goes in the username
# field; the password slot carries the admin token so a single autofill
# covers /admin/* routes.
#
# Reads ADMIN_API_TOKEN from /host/vexa/.env (mounted ro by the
# provisioner / vault-init compose service when Vexa is enabled).
VEXA_ENV_PATH_LOGIN="${VEXA_ENV_PATH:-/host/vexa/.env}"
vexa_login_password=""
if [ -f "$VEXA_ENV_PATH_LOGIN" ]; then
  line=$(grep -E '^ADMIN_API_TOKEN=' "$VEXA_ENV_PATH_LOGIN" | tail -n1)
  if [ -n "$line" ]; then
    val="${line#ADMIN_API_TOKEN=}"
    if [[ "$val" == \'*\' && "${#val}" -ge 2 ]]; then
      val="${val:1:${#val}-2}"
    fi
    vexa_login_password="$val"
  fi
fi
vexa_login_user=$(read_env ALFRED_OWNER_EMAIL || echo "$BW_USER")
upsert_login \
  "Vexa" \
  "$vexa_login_user" \
  "$vexa_login_password" \
  "https://${SUBDOMAIN}-vexa.${DOMAIN}"

log "import-logins.sh done"
