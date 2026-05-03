#!/usr/bin/env bash
# vault-init — pull every secret out of the local Vaultwarden and write them
# atomically into /host/compose/.env. Runs after vaultwarden:healthy on every
# `docker compose up`. Soft-failure mode: if Vaultwarden is unreachable we
# leave the existing .env in place and exit non-zero so docker compose surfaces
# the failure as the service-completed-with-non-zero, but we never delete or
# half-write the .env.
#
# Inputs (env, supplied by docker compose env_file):
#   BW_USER               — Sir's vaultwarden account email
#   BW_PASSWORD           — Sir's master password (also vault-init's auth credential)
#   BW_SERVER_URL         — internal vaultwarden URL (typically http://vaultwarden:80)
#   VAULT_INIT_PROTECTED  — optional, comma-separated env-var names to never
#                           overwrite from Vaultwarden (default: VAULTWARDEN_ADMIN_TOKEN,
#                           BW_USER, BW_PASSWORD, BW_SERVER_URL — the bootstrap blob)
#
# Outputs:
#   /host/compose/.env   — atomically replaced with the merged result
#
# Exit codes:
#   0  success: secrets fetched, .env updated
#   1  vaultwarden unreachable / login failed (soft — last-good .env stays)
#   2  data error (item parsing failure, partial response) — left .env unchanged
#   3  configuration error (missing env vars, bad path)
set -eo pipefail

ENV_PATH="${ENV_PATH:-/host/compose/.env}"
PROTECTED_DEFAULT="VAULTWARDEN_ADMIN_TOKEN,BW_USER,BW_PASSWORD,BW_SERVER_URL"
PROTECTED="${VAULT_INIT_PROTECTED:-$PROTECTED_DEFAULT}"

log() { echo "[vault-init] $*" >&2; }
fatal() { log "FATAL: $*"; exit 3; }

# 1. Sanity-check inputs.
[ -n "$BW_USER" ]       || fatal "BW_USER unset"
[ -n "$BW_PASSWORD" ]   || fatal "BW_PASSWORD unset"
[ -n "$BW_SERVER_URL" ] || fatal "BW_SERVER_URL unset"
[ -d "$(dirname "$ENV_PATH")" ] || fatal "$(dirname "$ENV_PATH") does not exist (mount /host/compose?)"

# 2. Configure bw CLI server and probe reachability. If vaultwarden is wedged,
#    exit 1 immediately — leaves last-good .env in place.
log "Configuring bw to point at $BW_SERVER_URL"
bw config server "$BW_SERVER_URL" >/dev/null

PROBE_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$BW_SERVER_URL/alive" || true)
if [ "$PROBE_HTTP" != "200" ]; then
  log "Vaultwarden /alive returned $PROBE_HTTP — leaving .env untouched"
  exit 1
fi

# 3. Login + unlock. `bw login` returns the session token on stdout when
#    --raw is set; we capture it and pass it through to subsequent calls.
#    On already-logged-in state, `bw login` errors — handle by re-using.
log "Logging in to Vaultwarden as $BW_USER"
LOGIN_OUT=$(bw login "$BW_USER" "$BW_PASSWORD" --raw 2>&1) || LOGIN_RC=$?
LOGIN_RC=${LOGIN_RC:-0}

if [ "$LOGIN_RC" -ne 0 ]; then
  # Maybe we're already logged in from a prior run — try `bw unlock` instead.
  if echo "$LOGIN_OUT" | grep -q "already logged in"; then
    log "Already logged in; unlocking"
    LOGIN_OUT=$(bw unlock "$BW_PASSWORD" --raw 2>&1) || {
      log "bw unlock failed: $LOGIN_OUT"
      exit 1
    }
  else
    log "bw login failed: $LOGIN_OUT"
    exit 1
  fi
fi

BW_SESSION="$LOGIN_OUT"
export BW_SESSION
[ -n "$BW_SESSION" ] || { log "empty session token after login"; exit 1; }

# 4. Sync.
log "Syncing"
bw sync >/dev/null

# 5. List items. Each managed env var is stored as a Bitwarden item whose
#    `name` is the env-var name and whose `login.password` is the value.
log "Listing items"
ITEMS_JSON=$(bw list items 2>/dev/null) || { log "bw list items failed"; exit 2; }

# Sanity: the response must be a JSON array.
echo "$ITEMS_JSON" | jq -e 'type == "array"' >/dev/null 2>&1 || {
  log "bw list items did not return an array"
  exit 2
}

ITEM_COUNT=$(echo "$ITEMS_JSON" | jq 'length')
if [ "$ITEM_COUNT" -eq 0 ]; then
  log "Vaultwarden contains zero items — refusing to wipe .env. Either the bootstrap migration hasn't run yet (Phase 1 step 9) or someone deleted everything. Leaving last-good .env in place."
  exit 1
fi
log "Got $ITEM_COUNT items from Vaultwarden"

# 6. Build the new .env atomically.
#    Algorithm:
#      a. Read existing .env line-by-line.
#      b. For each KEY=value line where KEY is in PROTECTED, copy verbatim.
#      c. For each KEY=value line where KEY appears in Vaultwarden, replace
#         the value with the Vaultwarden value.
#      d. For every Vaultwarden item whose name didn't match anything in .env,
#         append it as a new line.
#      e. Comments, blank lines, and unknown keys are preserved verbatim
#         (we don't delete entries that aren't in Vaultwarden — that would
#         break tenants with one-off keys).
#      f. Write to .env.next, then atomically mv into place.

NEW_ENV=$(mktemp /tmp/.env.next.XXXXXX)
trap 'rm -f "$NEW_ENV"' EXIT

PROTECTED_RE=$(echo "$PROTECTED" | tr ',' '|')

# vault_lookup KEY -> value (or empty if no match)
vault_lookup() {
  echo "$ITEMS_JSON" | jq -r --arg k "$1" '
    .[] | select(.name == $k) | .login.password // empty
  ' | head -n1
}

# Track which Vaultwarden items we've used so we know what to append at the end.
USED_KEYS=$(mktemp /tmp/used.XXXXXX)
trap 'rm -f "$NEW_ENV" "$USED_KEYS"' EXIT
: > "$USED_KEYS"

# Walk existing .env; if missing (first install), start empty.
if [ -f "$ENV_PATH" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Preserve blank lines + comments verbatim.
    if [[ -z "$line" ]] || [[ "$line" =~ ^[[:space:]]*# ]]; then
      printf '%s\n' "$line" >> "$NEW_ENV"
      continue
    fi
    # Match KEY=value (KEY = uppercase + digits + underscores).
    if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)= ]]; then
      key="${BASH_REMATCH[1]}"
      # Protected: copy verbatim.
      if [[ "$key" =~ ^(${PROTECTED_RE})$ ]]; then
        printf '%s\n' "$line" >> "$NEW_ENV"
        continue
      fi
      # Vaultwarden has a value for this key: replace.
      val=$(vault_lookup "$key")
      if [ -n "$val" ]; then
        printf '%s=%s\n' "$key" "$val" >> "$NEW_ENV"
        printf '%s\n' "$key" >> "$USED_KEYS"
      else
        # Not in Vaultwarden: keep the existing line.
        printf '%s\n' "$line" >> "$NEW_ENV"
      fi
    else
      # Not a recognisable env line; keep verbatim.
      printf '%s\n' "$line" >> "$NEW_ENV"
    fi
  done < "$ENV_PATH"
fi

# Append Vaultwarden items not already used in the existing .env.
APPENDED=0
echo "$ITEMS_JSON" | jq -r '.[] | "\(.name)\t\(.login.password // "")"' | while IFS=$'\t' read -r key val; do
  # Skip protected (we never write them out from Vaultwarden).
  if [[ "$key" =~ ^(${PROTECTED_RE})$ ]]; then continue; fi
  # Skip if already written above.
  if grep -qx "$key" "$USED_KEYS"; then continue; fi
  # Empty value or non-uppercase key → skip; not a managed secret.
  if [ -z "$val" ] || [[ ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then continue; fi
  printf '%s=%s\n' "$key" "$val" >> "$NEW_ENV"
  APPENDED=$((APPENDED + 1))
done

# 7. Atomically replace.
chmod 600 "$NEW_ENV"
mv -f "$NEW_ENV" "$ENV_PATH"
trap - EXIT
rm -f "$USED_KEYS"

USED_COUNT=$(wc -l < "$USED_KEYS" 2>/dev/null || echo 0)
log ".env updated ($ITEM_COUNT items in vault, $USED_COUNT replaced in-place, $APPENDED appended)"
exit 0
