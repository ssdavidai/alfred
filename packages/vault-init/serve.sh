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

# Wait up to 5 minutes for the bootstrap creds to appear. setupVaultwarden
# may write BW_USER / BW_PASSWORD AFTER vault-cli has already started, in
# which case docker compose's `restart: unless-stopped` keeps relaunching
# us until the values land. Without this grace window vault-cli hits
# fatal immediately on the first launch (when .env doesn't yet have the
# Vaultwarden block), gets restarted by Docker, fails again, and shows
# up as "degraded" in the dashboard health check until the second
# bootstrap.sh `docker compose up -d` propagates the new env.
#
# Surfaced 2026-05-08 on daveszab tenant: even after I shipped a fix
# that seeds BW_USER/BW_PASSWORD/BW_SERVER_URL in upload_env BEFORE
# bootstrap.sh runs, this defense-in-depth keeps us resilient against
# any future provisioning ordering changes.
GRACE_DEADLINE=$((SECONDS + 300))   # 5 minutes
while [ -z "$BW_USER" ] || [ -z "$BW_PASSWORD" ] || [ -z "$BW_SERVER_URL" ]; do
  if [ "$SECONDS" -ge "$GRACE_DEADLINE" ]; then
    [ -n "$BW_USER" ]       || fatal "BW_USER unset (5min grace exhausted)"
    [ -n "$BW_PASSWORD" ]   || fatal "BW_PASSWORD unset (5min grace exhausted)"
    [ -n "$BW_SERVER_URL" ] || fatal "BW_SERVER_URL unset (5min grace exhausted)"
  fi
  log "Waiting for BW_USER/BW_PASSWORD/BW_SERVER_URL to appear in env (have: BW_USER=${BW_USER:+set} BW_PASSWORD=${BW_PASSWORD:+set} BW_SERVER_URL=${BW_SERVER_URL:+set})"
  sleep 10
  # Re-source .env if it's mounted into the container — covers the case
  # where setupVaultwarden writes new vars but our process doesn't see
  # them without a re-read. Docker compose's env_file injects at start
  # only, so this is a host-bind-mount fallback. Most deployments don't
  # mount .env into vault-cli, so this is a no-op there.
  if [ -f /host/compose/.env ]; then
    set -o allexport
    . /host/compose/.env 2>/dev/null || true
    set +o allexport
  fi
done

log "Configuring bw → $BW_SERVER_URL"
# Bitwarden CLI refuses `bw config server` while a session is logged in. After
# a container restart the previous session's state can survive on disk
# (~/.config/Bitwarden CLI), so we proactively logout first. `|| true` defangs
# set -e on a fresh container where there's nothing to log out of.
bw logout >/dev/null 2>&1 || true
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
