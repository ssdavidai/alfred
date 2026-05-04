#!/usr/bin/env bash
# vault-cli — long-running side-container that holds an unlocked bw session
# and exposes Vaultwarden over `bw serve` (Bitwarden's built-in local REST
# API). ctrl-api proxies the Vaultwarden MCP tool calls to this service over
# the compose internal network at http://vault-cli:8087.
#
# Why this exists: every Vaultwarden tool call from claude.ai would otherwise
# need to spin up a fresh `bw login` + `bw unlock` cycle, which is ~3 seconds
# of latency per call and stresses the auth surface unnecessarily. `bw serve`
# is the canonical way to keep an unlocked session warm for downstream
# consumers — it ships in the @bitwarden/cli package, exposes the same
# operations as the CLI, and re-uses the same vault-init image.
#
# Inputs (env, supplied by docker compose env_file):
#   BW_USER               — Sir's vaultwarden account email
#   BW_PASSWORD           — Sir's master password
#   BW_SERVER_URL         — internal vaultwarden URL (http://vaultwarden:80)
#   VAULT_CLI_PORT        — port for `bw serve` (default 8087)
#
# Health: on shutdown / signal we let bw exit cleanly so Docker can recreate
# us. On token expiry we restart the script (handled by compose's
# restart: unless-stopped), and the next `bw login` re-authenticates.

set -eo pipefail

PORT="${VAULT_CLI_PORT:-8087}"

log() { echo "[vault-cli] $*" >&2; }
fatal() { log "FATAL: $*"; exit 3; }

[ -n "$BW_USER" ]       || fatal "BW_USER unset"
[ -n "$BW_PASSWORD" ]   || fatal "BW_PASSWORD unset"
[ -n "$BW_SERVER_URL" ] || fatal "BW_SERVER_URL unset"

log "Configuring bw → $BW_SERVER_URL"
bw config server "$BW_SERVER_URL" >/dev/null

# Keep stderr separate from stdout — see vault-init.sh for the full
# punycode-warning rationale.
LOGIN_ERR=$(mktemp)
LOGIN_OUT=$(bw login "$BW_USER" "$BW_PASSWORD" --raw </dev/null 2>"$LOGIN_ERR") || LOGIN_RC=$?
LOGIN_RC=${LOGIN_RC:-0}

if [ "$LOGIN_RC" -ne 0 ]; then
  if grep -q "already logged in" "$LOGIN_ERR"; then
    log "Already logged in; unlocking"
    LOGIN_OUT=$(bw unlock "$BW_PASSWORD" --raw </dev/null 2>"$LOGIN_ERR") || {
      log "bw unlock failed: $(cat "$LOGIN_ERR")"
      exit 1
    }
  else
    log "bw login failed: $(cat "$LOGIN_ERR")"
    exit 1
  fi
fi
rm -f "$LOGIN_ERR"

export BW_SESSION="$LOGIN_OUT"
log "Session acquired (length ${#BW_SESSION})"

bw sync --session "$BW_SESSION" </dev/null >/dev/null
log "Initial sync complete"

# Background sync loop — refresh every 5 minutes so external edits in the
# Vaultwarden web UI propagate without manual `bw sync`.
(
  while true; do
    sleep 300
    bw sync --session "$BW_SESSION" </dev/null >/dev/null 2>&1 || true
  done
) &
SYNC_PID=$!
trap "kill $SYNC_PID 2>/dev/null || true" EXIT

# Hand stdin a /dev/null so bw doesn't try to be interactive.
log "Starting bw serve on 0.0.0.0:$PORT"
exec bw serve --hostname 0.0.0.0 --port "$PORT" --session "$BW_SESSION" </dev/null
