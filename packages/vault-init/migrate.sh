#!/usr/bin/env bash
# vaultwarden-migrate.sh — one-shot importer that reads a tenant's existing
# /opt/alfred/compose/.env and pushes every secret as a Bitwarden item into
# the tenant's local Vaultwarden.
#
# Idempotent-ish: if an item with the same name already exists, we skip it
# rather than create a duplicate. Vaultwarden returns 200 + the new item on
# success; we trust bw create item's exit code.
#
# Run from inside the vault-init image (or any host with bw CLI), pointing at
# a running Vaultwarden where Sir's account is set up. Examples:
#   docker run --rm --network compose_default \
#     -v /opt/alfred/compose:/host/compose:ro \
#     -e BW_USER=david@szabostuban.com \
#     -e BW_PASSWORD=<master-password> \
#     -e BW_SERVER_URL=http://vaultwarden:80 \
#     ssdavidai00/alfred-vault-init:latest \
#     bash /host/compose/vaultwarden-migrate.sh /host/compose/.env
#
# Inputs:
#   $1                    — path to .env to import (default: /host/compose/.env)
#   BW_USER               — Sir's vaultwarden account email
#   BW_PASSWORD           — Sir's master password
#   BW_SERVER_URL         — internal vaultwarden URL
#   MIGRATE_DRY_RUN=1     — log intended actions, don't write
set -eo pipefail

ENV_PATH="${1:-/host/compose/.env}"
DRY_RUN="${MIGRATE_DRY_RUN:-0}"

# Bootstrap entries — never imported, always live in .env locally so vault-init
# can authenticate to Vaultwarden in the first place.
SKIP_KEYS_RE='^(VAULTWARDEN_ADMIN_TOKEN|BW_USER|BW_PASSWORD|BW_SERVER_URL)$'

log() { echo "[migrate] $*" >&2; }
fatal() { log "FATAL: $*"; exit 2; }

[ -n "$BW_USER" ]       || fatal "BW_USER unset"
[ -n "$BW_PASSWORD" ]   || fatal "BW_PASSWORD unset"
[ -n "$BW_SERVER_URL" ] || fatal "BW_SERVER_URL unset"
[ -f "$ENV_PATH" ]      || fatal "$ENV_PATH not readable"

log "Configuring bw → $BW_SERVER_URL"
bw config server "$BW_SERVER_URL" >/dev/null

log "Logging in as $BW_USER"
LOGIN_OUT=$(bw login "$BW_USER" "$BW_PASSWORD" --raw 2>&1) || LOGIN_RC=$?
LOGIN_RC=${LOGIN_RC:-0}
if [ "$LOGIN_RC" -ne 0 ]; then
  if echo "$LOGIN_OUT" | grep -q "already logged in"; then
    LOGIN_OUT=$(bw unlock "$BW_PASSWORD" --raw 2>&1) || fatal "bw unlock failed: $LOGIN_OUT"
  else
    fatal "bw login failed: $LOGIN_OUT"
  fi
fi
export BW_SESSION="$LOGIN_OUT"

log "Syncing"
bw sync >/dev/null

# Pull existing item names so we can dedupe on re-runs.
EXISTING_NAMES=$(bw list items | jq -r '.[].name' | sort -u)

CREATED=0
SKIPPED=0
DEDUPED=0

while IFS= read -r line || [ -n "$line" ]; do
  # Strip comments + blanks.
  [[ -z "$line" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  # Match KEY=value
  if [[ ! "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
    continue
  fi
  key="${BASH_REMATCH[1]}"
  val="${BASH_REMATCH[2]}"

  # Strip surrounding single quotes if present (writeTenantEnv wraps values).
  if [[ "$val" =~ ^\'(.*)\'$ ]]; then
    val="${BASH_REMATCH[1]}"
  fi

  # Bootstrap entries: never imported.
  if [[ "$key" =~ $SKIP_KEYS_RE ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Already in Vaultwarden? Skip.
  if echo "$EXISTING_NAMES" | grep -qx "$key"; then
    DEDUPED=$((DEDUPED + 1))
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] would create: $key (${#val} chars)"
    CREATED=$((CREATED + 1))
    continue
  fi

  # bw create item expects base64-encoded JSON.
  ITEM_JSON=$(jq -n \
    --arg name "$key" \
    --arg pw "$val" \
    --arg notes "Imported from /opt/alfred/compose/.env on $(date -u +%Y-%m-%dT%H:%M:%SZ). Env-var name: $key" \
    '{
      type: 1,
      name: $name,
      notes: $notes,
      login: {
        username: null,
        password: $pw,
        uris: []
      }
    }')
  ITEM_B64=$(printf '%s' "$ITEM_JSON" | base64 | tr -d '\n')

  if bw create item "$ITEM_B64" >/dev/null 2>&1; then
    CREATED=$((CREATED + 1))
    log "+ $key"
  else
    log "FAILED: $key (bw create item exit non-zero)"
  fi
done < "$ENV_PATH"

log "Done. created=$CREATED, deduped=$DEDUPED (already in vault), skipped=$SKIPPED (bootstrap entries)"
exit 0
