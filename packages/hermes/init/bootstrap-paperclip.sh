#!/usr/bin/env bash
# =============================================================================
# bootstrap-paperclip.sh — idempotent FULL-SEED bootstrap of the Paperclip
# sidecar. After this script runs, the principal lands on /dashboard with
# Paperclip already populated: company "Alfred", CEO agent "hermes", and
# a runtime token persisted into /opt/alfred/.env so Hermes' Paperclip MCP
# server picks it up on next restart. Zero CLI, zero wizard.
#
# Why a separate script (and a separate compose service)?
# -------------------------------------------------------
# The main alfred-init container has no docker.sock and no dependency on
# paperclip's health gate — both of which we need here. So this script ships
# in the same image but is invoked as the entrypoint of a sibling `paperclip-
# init` compose service that:
#   * mounts /var/run/docker.sock RO (we only run `docker exec` / `inspect`)
#   * has alfred_data:/alfred-data so the parsed invite URL + seed
#     credentials JSON become single-source-of-truth files ctrl-api reads.
#   * has the host compose dir bind-mounted at /srv/alfred-black so we can
#     persist PAPERCLIP_AGENT_TOKEN/_ID/_COMPANY_ID into /opt/alfred/.env.
#   * depends_on: paperclip { condition: service_healthy } so by the time
#     this runs, paperclip's web server is up.
#
# What it does (11 steps; 1–5 wire up the invite, 6–11 redeem it headlessly)
# --------------------------------------------------------------------------
#   1. Wait for the paperclip container to be healthy (up to 2 min). Compose
#      already gates on service_healthy so this is normally a single poll;
#      kept as a belt-and-braces guard against a late health flip.
#   2. Bail out (exit 0, idempotent) when /opt/alfred/.env already has
#      PAPERCLIP_AGENT_TOKEN — that is the authoritative "fully seeded"
#      marker, set by step 11. Re-runs on home (already seeded) are no-ops.
#   3. Run `pnpm paperclipai onboard -y --bind lan` as uid 1000 (`node`).
#      Running as root creates a uid 0 ownership trap on the paperclip
#      volume (live-observed on home 2026-05-27); --user node sidesteps it
#      entirely. -y suppresses interactive prompts; --bind lan trusts
#      compose-network callers.
#   4. Run `pnpm paperclipai auth bootstrap-ceo --force` (also as `node`).
#      --force revokes any stale invites and mints a fresh one. Parse the
#      "Invite URL: https://…" line out of stdout — Paperclip prints this
#      banner verbatim on success.
#   5. Write the parsed URL to /alfred-data/paperclip-ceo-invite.txt with
#      0644 so ctrl-api (root) can read it. This is the fallback artifact
#      if the headless redeem (steps 6–11) fails partway through; the
#      /channels card surfaces it as a click-through invite link.
#   6. POST /api/auth/sign-up/email with the system identity
#      (PAPERCLIP_SEED_EMAIL, defaulting to alfred@${DOMAIN}) and a freshly
#      generated 24-char OWASP-class password. Origin header is REQUIRED or
#      Better-Auth refuses to issue Set-Cookie. Persist session cookie jar.
#   7. POST /api/invites/<token>/accept {"requestType":"human"} with the
#      cookie jar + Origin. Origin REQUIRED or 403 (board-mutation guard).
#      Response: {bootstrapAccepted:true}.
#   8. POST /api/companies/ {"name":"Alfred", description:"..."} → company id.
#   9. POST /api/companies/<id>/agents {name:"hermes", role:"ceo", ...} →
#      agent id. adapterType=hermes_local because Alfred's Hermes is
#      the agent's runtime — the alfred-black paperclip image ships a
#      patched hermes-paperclip-adapter whose execute() POSTs every
#      heartbeat to hermes:18789/v1/responses (see
#      packages/paperclip/DESIGN.md).
#  10. POST /api/agents/<id>/keys {name:"hermes-runtime"} → token: pcp_… .
#      This is the long-lived token Hermes' paperclip MCP server uses.
#  11. Persist the password + token tuple. Two artifacts:
#       a. Append PAPERCLIP_AGENT_TOKEN, PAPERCLIP_AGENT_ID,
#          PAPERCLIP_COMPANY_ID to /opt/alfred/.env (mounted via the host
#          compose bind-mount at /srv/alfred-black/.env). ctrl-api +
#          hermes-init both read this on next start.
#       b. Write /alfred-data/paperclip-seed-credentials.json (mode 0600)
#          carrying the email + password + token + ids. The /channels
#          Paperclip card surfaces a "Reveal seed credentials" button
#          backed by this file so the principal can recover the password
#          if they ever need to sign in via the UI.
#
# Failure modes
# -------------
# If steps 6–11 fail (network blip, paperclip restart, OOM), the script
# logs the failure and exits NON-ZERO. The invite file from step 5 is
# preserved, so the dashboard card still renders a click-through invite
# and the principal can fall back to claiming the account manually. Re-
# running the script on a tenant that has a stale invite but no
# PAPERCLIP_AGENT_TOKEN attempts the headless redeem afresh.
#
# Configuration knobs (env)
# -------------------------
#   * PAPERCLIP_SEED_EMAIL   — system identity email; default alfred@${DOMAIN}
#   * PAPERCLIP_SEED_NAME    — display name for the system identity;
#                              default "Alfred"
#   * PAPERCLIP_SEED_COMPANY — company name; default "Alfred"
#   * PAPERCLIP_BASE_URL     — Paperclip's public origin used for Origin
#                              header + invite URL base; default
#                              https://paperclip.${DOMAIN}
#   * COMPOSE_DIR_HOST       — host path of the compose dir (default
#                              /opt/alfred). bootstrap.sh passes this as
#                              /srv/alfred-black inside the init container
#                              via the same bind-mount ctrl-api uses.
#
# Constraints
# -----------
#   * Every `docker exec` uses `--user node` (uid 1000). Sir's 2026-05-27
#     manual run hit the trap of root-owned config.json + a container
#     restart-looping unable to read its own files. Bake the user flag in.
#   * Idempotent: re-running on an already-bootstrapped tenant is a no-op.
#   * Tenant container name must be discoverable. Compose names containers
#     `<project>_paperclip_1` or `<project>-paperclip-1` depending on
#     version; resolve via `docker ps --filter label=com.docker.compose.
#     service=paperclip --format '{{.Names}}'` so we don't hard-code home's
#     `alfred-black-paperclip-1`.
#   * The Better-Auth session cookie name is
#     `__Secure-paperclip-<instance>.session_token`. Use `curl -c jar` then
#     `-b jar` so the cookie name is irrelevant to this script.
#   * Origin header is mandatory on BOTH /api/auth/sign-up/email AND
#     /api/invites/<token>/accept (see paperclip-bootstrap-headless memory).
# =============================================================================
set -euo pipefail

LOG_PREFIX="[paperclip-bootstrap]"
log() { echo "$LOG_PREFIX $*"; }

INVITE_FILE="${INVITE_FILE:-/alfred-data/paperclip-ceo-invite.txt}"
# Credentials surface: 0600-mode JSON dropped here so ctrl-api can render a
# "Reveal seed credentials" affordance on the /channels card. Mode 0600
# means only root inside ctrl-api can read it (alfred_data is a private
# named volume; not host-shared).
SEED_CREDENTIALS_FILE="${SEED_CREDENTIALS_FILE:-/alfred-data/paperclip-seed-credentials.json}"
# Host compose dir, bind-mounted into the paperclip-init container at
# /srv/alfred-black. We persist PAPERCLIP_AGENT_TOKEN/_AGENT_ID/_COMPANY_ID
# into <ENV_FILE> so ctrl-api + hermes both pick them up on next restart.
ENV_FILE="${ENV_FILE:-/srv/alfred-black/.env}"
WAIT_TIMEOUT_SECS="${WAIT_TIMEOUT_SECS:-120}"
WAIT_INTERVAL_SECS="${WAIT_INTERVAL_SECS:-5}"

# System identity defaults — every knob is overridable via the paperclip-init
# compose env so a future re-skin can swap "Alfred" without code edits.
DOMAIN_DEFAULT="${DOMAIN:-alfred.black}"
PAPERCLIP_SEED_EMAIL="${PAPERCLIP_SEED_EMAIL:-alfred@${DOMAIN_DEFAULT}}"
PAPERCLIP_SEED_NAME="${PAPERCLIP_SEED_NAME:-Alfred}"
PAPERCLIP_SEED_COMPANY="${PAPERCLIP_SEED_COMPANY:-Alfred}"
PAPERCLIP_SEED_COMPANY_DESCRIPTION="${PAPERCLIP_SEED_COMPANY_DESCRIPTION:-The principals household and back office. Alfred works here as a managed CEO.}"
PAPERCLIP_SEED_AGENT_NAME="${PAPERCLIP_SEED_AGENT_NAME:-hermes}"
PAPERCLIP_SEED_AGENT_TITLE="${PAPERCLIP_SEED_AGENT_TITLE:-Chief Executive Agent}"
PAPERCLIP_SEED_AGENT_CAPABILITIES="${PAPERCLIP_SEED_AGENT_CAPABILITIES:-Reports through Alfred to the principal. Routes tasks via Hermes to specialised tools and channels.}"
PAPERCLIP_BASE_URL="${PAPERCLIP_BASE_URL:-https://paperclip.${DOMAIN_DEFAULT}}"

# Steps 6–11 talk to paperclip:3100 from the paperclip-init container over
# the compose network. We spoof the Host header so Better-Auth's
# trustedOrigins allowlist accepts us; the Origin header carries the same
# public URL the dashboard would (mandatory — see memory:paperclip-
# bootstrap-headless).
PAPERCLIP_INTERNAL_URL="${PAPERCLIP_INTERNAL_URL:-http://paperclip:3100}"

# Locate the paperclip container by compose service label. Falls back to a
# substring match on container name so we degrade gracefully if labels are
# stripped (e.g. some docker-in-docker setups).
resolve_paperclip_container() {
    local name
    name=$(docker ps --filter "label=com.docker.compose.service=paperclip" \
        --format '{{.Names}}' 2>/dev/null | head -n1 || true)
    if [[ -z "$name" ]]; then
        name=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '(^|[-_])paperclip([-_]|$)' | head -n1 || true)
    fi
    echo "$name"
}

# Wait for paperclip's healthcheck to flip to "healthy". Compose's
# `depends_on: condition: service_healthy` already does this, but we re-check
# in-script so the script is safe to invoke standalone (e.g. manual rerun).
wait_for_paperclip_health() {
    local container="$1"
    local deadline=$(( $(date +%s) + WAIT_TIMEOUT_SECS ))
    while [[ $(date +%s) -lt $deadline ]]; do
        local status
        status=$(docker inspect "$container" --format '{{.State.Health.Status}}' 2>/dev/null || echo "missing")
        case "$status" in
            healthy)
                log "paperclip container '$container' is healthy"
                return 0
                ;;
            "")
                # No healthcheck defined on the container — fall back to
                # State.Status=running. Shouldn't happen on our stack
                # (compose pins a healthcheck) but defend against drift.
                local running
                running=$(docker inspect "$container" --format '{{.State.Running}}' 2>/dev/null || echo "false")
                if [[ "$running" == "true" ]]; then
                    log "paperclip has no healthcheck but is running — proceeding"
                    return 0
                fi
                ;;
            missing)
                log "paperclip container '$container' not found yet; retrying in ${WAIT_INTERVAL_SECS}s…"
                ;;
            *)
                log "paperclip health=$status; waiting ${WAIT_INTERVAL_SECS}s…"
                ;;
        esac
        sleep "$WAIT_INTERVAL_SECS"
    done
    log "ERROR: paperclip container did not become healthy within ${WAIT_TIMEOUT_SECS}s"
    return 1
}

# Idempotency probe — true when we've already FULLY seeded this tenant.
# Authoritative marker is PAPERCLIP_AGENT_TOKEN in the host .env (set by
# step 11). The invite file + config.json are partial-progress markers —
# present after step 5 but before steps 6–11 finish — so we keep them as
# a fallback idempotency hint when the host .env can't be read (e.g.
# someone runs this script outside the compose service without the bind
# mount). The two-condition fallback rules out a partial first-run (invite
# file written but config.json never landed because pnpm crashed mid-way).
already_bootstrapped() {
    # Primary: full-seed marker in /opt/alfred/.env.
    if [[ -r "$ENV_FILE" ]] && grep -qE '^PAPERCLIP_AGENT_TOKEN=.+' "$ENV_FILE"; then
        return 0
    fi
    # Without the token, even a captured invite + config.json doesn't mean
    # we are done — the headless redeem (steps 6–11) still needs to run.
    return 1
}

# Run paperclip's onboarding ritual (config.json + .env) as the `node` user.
# -y skips prompts; --bind lan trusts compose-network callers (the alternative
# `local` is loopback-only and breaks heartbeats from sibling containers).
#
# Quirk: `paperclipai onboard` performs its doctor checks + writes config.json
# THEN tries to start a Paperclip server on port 3100. The paperclip container
# is already serving on 3100 (compose started it before we ran), so the start
# step fails with "Port 3100 is already in use" and the command exits 1 —
# even though the side effect we cared about (config.json on disk) succeeded.
# Live-observed on joe + rj 2026-05-27. We swallow the non-zero exit when
# config.json appears afterward.
paperclip_onboard() {
    local container="$1"
    log "running 'pnpm paperclipai onboard -y --bind lan' (as node)…"
    local rc=0
    docker exec --user node "$container" pnpm paperclipai onboard -y --bind lan || rc=$?
    # Verify the side effect — config.json on disk — regardless of exit code.
    if docker exec --user node "$container" test -s /paperclip/instances/default/config.json >/dev/null 2>&1; then
        if [[ $rc -ne 0 ]]; then
            log "  (onboard exited $rc, but config.json is present — known port-3100 race; treating as success)"
        fi
        return 0
    fi
    log "ERROR: 'pnpm paperclipai onboard' failed (exit=$rc) and config.json is absent"
    return 1
}

# Run bootstrap-ceo and capture the "Invite URL: …" line. Paperclip prints
# the URL verbatim on success (banner format, observed on home 2026-05-27).
# We grab stdout+stderr together — early Paperclip builds wrote the banner to
# stderr and the live one writes it to stdout; tolerate either.
#
# Retry on parse failure with a short delay — on fresh tenants `onboard`
# OOMs while trying to start a duplicate server (mem_limit 1g is tight),
# which can take paperclip itself down briefly. The subsequent bootstrap-
# ceo `docker exec` then either fails outright or produces output with no
# 'Invite URL:' line. A 15-second sleep + 2 retries reliably catches this
# (live-confirmed on zsolt 2026-05-27).
#
# --force + --base-url: --force revokes any stale invites so a re-run
# always yields a redeemable token (the raw token is only in stdout — the
# embedded postgres only stores the sha256 hash); --base-url pins the URL
# Paperclip prints to the tenant's public origin so the /channels card
# surfaces a click-through link the principal's browser can actually
# reach (the in-container default would be http://paperclip:3100 which
# only the compose network can resolve).
paperclip_bootstrap_ceo() {
    local container="$1"
    local out_file
    out_file=$(mktemp)
    local attempts=3
    for attempt in $(seq 1 $attempts); do
        log "running 'pnpm paperclipai auth bootstrap-ceo --force --base-url $PAPERCLIP_BASE_URL' (attempt $attempt/$attempts, as node)…"
        if docker exec --user node "$container" \
            pnpm paperclipai auth bootstrap-ceo --force --base-url "$PAPERCLIP_BASE_URL" \
            >"$out_file" 2>&1; then
            local url
            url=$(grep -oE 'Invite URL: https?://[^[:space:]]+' "$out_file" | head -n1 | sed -E 's/^Invite URL: //')
            if [[ -n "$url" ]]; then
                log "captured invite URL: $url"
                # Write atomically (.tmp then rename) so a partial write never
                # leaves ctrl-api reading a truncated URL.
                local tmp="${INVITE_FILE}.tmp"
                printf '%s\n' "$url" > "$tmp"
                chmod 0644 "$tmp" 2>/dev/null || true
                mv "$tmp" "$INVITE_FILE"
                log "wrote $INVITE_FILE"
                rm -f "$out_file"
                return 0
            fi
            log "  attempt $attempt: command succeeded but no 'Invite URL:' in output (paperclip may be recovering)"
        else
            log "  attempt $attempt: 'pnpm paperclipai auth bootstrap-ceo' exited non-zero"
        fi
        if [[ $attempt -lt $attempts ]]; then
            # Wait for paperclip to settle (an OOM during onboard can briefly
            # kill paperclip; compose restarts it but the healthcheck takes
            # ~20s to flip back to healthy).
            log "  sleeping 20s before retry…"
            sleep 20
            # Re-verify paperclip is healthy before retrying (up to 60s).
            local waited=0
            while [[ $waited -lt 60 ]]; do
                local h
                h=$(docker inspect "$container" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
                if [[ "$h" = "healthy" ]]; then break; fi
                sleep 5
                waited=$((waited + 5))
            done
        fi
    done
    log "ERROR: could not capture 'Invite URL:' after $attempts attempts; last output:"
    sed 's/^/  /' "$out_file" || true
    rm -f "$out_file"
    return 1
}

# =============================================================================
# Steps 6–11 — headless invite redeem + company/agent/key seeding.
# Implemented as a single Python script for ergonomics: the cookie jar
# survives across requests, JSON parsing is built-in, and the error
# messages are easier to surface than 4 shell heredocs would be. Python3
# is in the init image (FROM python:3.12-slim-bookworm).
# =============================================================================

# Extract the bare invite token from the parsed invite URL. The URL looks
# like https://paperclip.<tenant>.alfred.black/invite/pcp_bootstrap_<hex>;
# the token is the last path segment.
extract_invite_token() {
    local url="$1"
    # Strip query/fragment; take everything after the last '/'.
    local stripped="${url%%\?*}"
    stripped="${stripped%%#*}"
    echo "${stripped##*/}"
}

# Generate an OWASP-class password (24 chars, base64 alphabet minus URL-
# unsafe punctuation). openssl is in the python:3.12-slim image; in case
# it isn't, fall back to /dev/urandom.
generate_seed_password() {
    if command -v openssl >/dev/null 2>&1; then
        # Pull 48 bytes of entropy, strip /+= → safe-ish alphabet, take 24.
        openssl rand -base64 48 | tr -d '/+=\n' | head -c 24
    else
        # head -c 24 on a /dev/urandom → base64 → strip non-alnum.
        # Slight bias toward shorter outputs; still >100 bits of entropy.
        head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 24
    fi
}

# Run the Python redeem script. Args:
#   $1 — invite URL captured by paperclip_bootstrap_ceo
#   $2 — seed password
# Reads from env: PAPERCLIP_SEED_*, PAPERCLIP_BASE_URL, PAPERCLIP_INTERNAL_URL,
#                 ENV_FILE, SEED_CREDENTIALS_FILE
# Exit non-zero on any HTTP failure; logs the failing step + body.
run_headless_redeem() {
    local invite_url="$1"
    local seed_password="$2"
    local invite_token
    invite_token=$(extract_invite_token "$invite_url")
    if [[ -z "$invite_token" ]]; then
        log "ERROR: could not extract invite token from URL: $invite_url"
        return 1
    fi
    log "step 6–11: redeeming invite headlessly (token: ${invite_token:0:18}…)"

    # Export everything Python needs as env. Heredoc terminator is
    # single-quoted so $VAR expansions stay inside Python's hands — never
    # let the shell interpolate into the Python body (memory note).
    PAPERCLIP_INVITE_TOKEN="$invite_token" \
    PAPERCLIP_SEED_PASSWORD="$seed_password" \
    PAPERCLIP_BASE_URL="$PAPERCLIP_BASE_URL" \
    PAPERCLIP_INTERNAL_URL="$PAPERCLIP_INTERNAL_URL" \
    PAPERCLIP_SEED_EMAIL="$PAPERCLIP_SEED_EMAIL" \
    PAPERCLIP_SEED_NAME="$PAPERCLIP_SEED_NAME" \
    PAPERCLIP_SEED_COMPANY="$PAPERCLIP_SEED_COMPANY" \
    PAPERCLIP_SEED_COMPANY_DESCRIPTION="$PAPERCLIP_SEED_COMPANY_DESCRIPTION" \
    PAPERCLIP_SEED_AGENT_NAME="$PAPERCLIP_SEED_AGENT_NAME" \
    PAPERCLIP_SEED_AGENT_TITLE="$PAPERCLIP_SEED_AGENT_TITLE" \
    PAPERCLIP_SEED_AGENT_CAPABILITIES="$PAPERCLIP_SEED_AGENT_CAPABILITIES" \
    ENV_FILE="$ENV_FILE" \
    SEED_CREDENTIALS_FILE="$SEED_CREDENTIALS_FILE" \
    LOG_PREFIX="$LOG_PREFIX" \
    python3 - <<'PYEOF'
"""
Headless redeem (steps 6-11). All HTTP via urllib so the init image needs
no extra wheels. We talk to paperclip:3100 over the compose network and
spoof the Host header so Better-Auth's trustedOrigins allowlist accepts
us; the Origin header carries the same public URL the dashboard would
(mandatory - Better-Auth drops Set-Cookie without it, and the
board-mutation guard 403s without it).
"""
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


PREFIX = os.environ.get("LOG_PREFIX", "[paperclip-bootstrap]")


def log(msg):
    print(f"{PREFIX} {msg}", flush=True)


def die(step, exc, body=None):
    log(f"ERROR: step {step} failed: {exc}")
    if body is not None:
        try:
            snippet = body.decode("utf-8", "replace")
        except Exception:
            snippet = repr(body)
        log(f"  response body: {snippet[:512]}")
    sys.exit(2)


# --------------------------------------------------------------------------
# Resolve target URL. We point urllib at PAPERCLIP_INTERNAL_URL (compose-
# network DNS, e.g. http://paperclip:3100) but override the Host header to
# the public origin so Better-Auth's trustedOrigins allowlist accepts the
# request. Origin must carry the public origin too.
# --------------------------------------------------------------------------
internal_url = os.environ["PAPERCLIP_INTERNAL_URL"].rstrip("/")
public_url = os.environ["PAPERCLIP_BASE_URL"].rstrip("/")
public_host = urlparse(public_url).netloc

cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(cookies)
)


def request(method, path, body=None):
    """POST/GET helper. body=None -> no Content-Type, no body bytes."""
    url = internal_url + path
    data = None
    headers = {
        "Host": public_host,
        "Origin": public_url,
        "Accept": "application/json",
        "User-Agent": "alfred-paperclip-init/1.0",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        resp = opener.open(req, timeout=30)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)
    except urllib.error.URLError as e:
        die(f"{method} {path}", e)
    return resp.status, resp.read(), dict(resp.headers)


# --------------------------------------------------------------------------
# Step 6 - sign up. Better-Auth /api/auth/sign-up/email creates the user
# AND returns a Set-Cookie session token. Origin header is mandatory or
# the cookie is dropped. Idempotency: if the user already exists (422 or
# 400 with EMAIL_TAKEN), we try /sign-in/email next so a partial prior
# run can resume.
# --------------------------------------------------------------------------
seed_email = os.environ["PAPERCLIP_SEED_EMAIL"]
seed_name = os.environ["PAPERCLIP_SEED_NAME"]
seed_password = os.environ["PAPERCLIP_SEED_PASSWORD"]

log(f"step 6: signing up system identity ({seed_email})")
code, body, _ = request("POST", "/api/auth/sign-up/email", {
    "name": seed_name,
    "email": seed_email,
    "password": seed_password,
})
if code >= 400:
    # Email-already-exists is recoverable: sign in instead so we get a
    # session cookie. Any other 4xx/5xx is fatal - die with the body so
    # the operator log shows the failure mode.
    try:
        err = json.loads(body or b"{}")
    except Exception:
        err = {}
    code_field = (err.get("code") or "").upper()
    if code in (400, 409, 422) and ("EMAIL" in code_field or "TAKEN" in code_field or "EXISTS" in code_field):
        log("  user already exists - signing in instead")
        code2, body2, _ = request("POST", "/api/auth/sign-in/email", {
            "email": seed_email,
            "password": seed_password,
        })
        if code2 >= 400:
            die("6 (sign-in fallback)", RuntimeError(f"HTTP {code2}"), body2)
    else:
        die("6 (sign-up)", RuntimeError(f"HTTP {code}"), body)

# --------------------------------------------------------------------------
# Step 7 - accept the bootstrap invite. requestType:"human" tells
# Paperclip we are claiming the CEO seat for a real user (not an agent).
# Origin header is mandatory or board-mutation-guard returns 403.
# --------------------------------------------------------------------------
invite_token = os.environ["PAPERCLIP_INVITE_TOKEN"]
log("step 7: accepting bootstrap invite")
code, body, _ = request(
    "POST",
    f"/api/invites/{urllib.parse.quote(invite_token, safe='')}/accept",
    {"requestType": "human"},
)
if code >= 400:
    die("7 (accept-invite)", RuntimeError(f"HTTP {code}"), body)
try:
    accept_resp = json.loads(body or b"{}")
except Exception:
    accept_resp = {}
# Treat any 2xx as "redeemed" - Paperclip responds with bootstrapAccepted:true
# on a fresh redeem, but a re-redeem on an already-accepted invite may carry
# a slightly different shape. Both flow into the next step the same way.
log(f"  accept ok: {json.dumps(accept_resp)[:200]}")

# --------------------------------------------------------------------------
# Step 8 - create the company. Hard-coded to "Alfred" so every tenant
# starts with the same shape; the principal can rename it later via
# Paperclip's UI (or the existing /channels card never has to show it).
# --------------------------------------------------------------------------
log(f"step 8: creating company '{os.environ['PAPERCLIP_SEED_COMPANY']}'")
code, body, _ = request("POST", "/api/companies/", {
    "name": os.environ["PAPERCLIP_SEED_COMPANY"],
    "description": os.environ["PAPERCLIP_SEED_COMPANY_DESCRIPTION"],
})
company = None
if code >= 400:
    # If the company already exists from a prior partial run, fall back
    # to GETting it. Paperclip's /api/companies returns the list; pick
    # the one with our seed name.
    if code in (400, 409, 422):
        log("  company exists - looking it up")
        code2, body2, _ = request("GET", "/api/companies/", None)
        if code2 >= 400:
            die("8 (companies lookup)", RuntimeError(f"HTTP {code2}"), body2)
        try:
            existing = json.loads(body2 or b"[]")
        except Exception:
            existing = []
        if isinstance(existing, list):
            for c in existing:
                if isinstance(c, dict) and c.get("name") == os.environ["PAPERCLIP_SEED_COMPANY"]:
                    company = c
                    break
        elif isinstance(existing, dict) and "data" in existing:
            for c in existing.get("data") or []:
                if isinstance(c, dict) and c.get("name") == os.environ["PAPERCLIP_SEED_COMPANY"]:
                    company = c
                    break
        if not company or not company.get("id"):
            die("8 (companies lookup)", RuntimeError("company not in list"), body2)
    else:
        die("8 (create-company)", RuntimeError(f"HTTP {code}"), body)
else:
    try:
        company = json.loads(body)
    except Exception:
        die("8 (parse-company)", RuntimeError("non-JSON response"), body)

company_id = company.get("id")
if not company_id:
    die("8", RuntimeError(f"no id in response: {company}"))
log(f"  company id: {company_id}")

# --------------------------------------------------------------------------
# Step 9 - create the CEO agent. adapterType=hermes_local because the
# alfred-black paperclip image ships a patched hermes-paperclip-adapter
# whose execute() calls hermes:18789/v1/responses over HTTP — every
# heartbeat round-trips through the tenant's own Hermes Agent
# container, no CLI binary required. See packages/paperclip/DESIGN.md
# for the mapping.
#
# Why not adapterType="openclaw_gateway"? That was the previous default;
# it pointed at a WebSocket gateway protocol Paperclip ships out-of-the-
# box but which alfred-black doesn't run. Live observation: agents
# created with openclaw_gateway never actually executed a heartbeat.
# --------------------------------------------------------------------------
log(f"step 9: creating agent '{os.environ['PAPERCLIP_SEED_AGENT_NAME']}' (CEO)")
agent_body = {
    "name": os.environ["PAPERCLIP_SEED_AGENT_NAME"],
    "role": "ceo",
    "title": os.environ["PAPERCLIP_SEED_AGENT_TITLE"],
    "adapterType": "hermes_local",
    "capabilities": os.environ["PAPERCLIP_SEED_AGENT_CAPABILITIES"],
}
code, body, _ = request("POST", f"/api/companies/{company_id}/agents", agent_body)
agent = None
if code >= 400 and code in (400, 409, 422):
    # Idempotency: agent already exists. GET the agent list and find
    # the one with our seed name.
    log("  agent exists - looking it up")
    code2, body2, _ = request("GET", f"/api/companies/{company_id}/agents", None)
    if code2 >= 400:
        die("9 (agents-list)", RuntimeError(f"HTTP {code2}"), body2)
    try:
        agents = json.loads(body2 or b"[]")
    except Exception:
        agents = []
    candidates = agents if isinstance(agents, list) else (agents.get("data") or [])
    for a in candidates or []:
        if isinstance(a, dict) and a.get("name") == os.environ["PAPERCLIP_SEED_AGENT_NAME"]:
            agent = a
            break
    if not agent:
        die("9 (agents-list)", RuntimeError("agent not in list"), body2)
elif code >= 400:
    die("9 (create-agent)", RuntimeError(f"HTTP {code}"), body)
else:
    try:
        agent = json.loads(body)
    except Exception:
        die("9 (parse-agent)", RuntimeError("non-JSON response"), body)

agent_id = agent.get("id")
if not agent_id:
    die("9", RuntimeError(f"no id in response: {agent}"))
log(f"  agent id: {agent_id}")

# --------------------------------------------------------------------------
# Step 10 - mint a runtime API key for the CEO agent. Returns
# {token:"pcp_..."} ONCE - the secret is never retrievable after this call.
# If we hit a 4xx because a key already exists, we can't recover its
# value - we'd have to revoke and re-create. For now, abort: the operator
# can wipe the alfred_data volume and re-run a clean seed.
# --------------------------------------------------------------------------
log("step 10: minting runtime API key for the agent")
code, body, _ = request("POST", f"/api/agents/{agent_id}/keys", {
    "name": "hermes-runtime",
})
if code >= 400:
    die("10 (create-agent-key)", RuntimeError(f"HTTP {code}"), body)
try:
    key_resp = json.loads(body)
except Exception:
    die("10 (parse-key)", RuntimeError("non-JSON response"), body)
agent_token = key_resp.get("token") or key_resp.get("apiKey") or key_resp.get("key")
if not agent_token:
    die("10", RuntimeError(f"no token in response: {list(key_resp.keys())}"))
log(f"  token captured ({len(agent_token)} chars; prefix {agent_token[:8]}...)")

# --------------------------------------------------------------------------
# Step 11a - persist the seed credentials JSON (0600). ctrl-api reads
# this to render a "Reveal seed credentials" affordance on the /channels
# card so the principal can recover the password if they ever want to
# sign in via Paperclip's UI directly.
# --------------------------------------------------------------------------
cred_path = Path(os.environ["SEED_CREDENTIALS_FILE"])
cred_path.parent.mkdir(parents=True, exist_ok=True)
cred_path.write_text(json.dumps({
    "email": seed_email,
    "name": seed_name,
    "password": seed_password,
    "company": os.environ["PAPERCLIP_SEED_COMPANY"],
    "company_id": company_id,
    "agent": os.environ["PAPERCLIP_SEED_AGENT_NAME"],
    "agent_id": agent_id,
    "agent_token": agent_token,
    "paperclip_url": public_url,
    "note": (
        "Seed credentials for the headless Paperclip CEO claim. "
        "Mode 0600 so only ctrl-api (root) can read this file. "
        "The principal can rotate the agent token via Paperclip's UI; "
        "the password lets them sign in to https://paperclip.<tenant> "
        "directly if they ever need to."
    ),
}, indent=2))
cred_path.chmod(0o600)
log(f"step 11a: wrote seed credentials -> {cred_path}")

# --------------------------------------------------------------------------
# Step 11b - append PAPERCLIP_AGENT_TOKEN / _AGENT_ID / _COMPANY_ID to
# /opt/alfred/.env (mounted into us as ENV_FILE). On the SaaS host the
# .env is owned by root:root mode 0600; the bind mount preserves
# ownership but the paperclip-init container runs as root inside the
# container so the write succeeds.
# --------------------------------------------------------------------------
env_path = Path(os.environ["ENV_FILE"])
existing_lines = env_path.read_text().splitlines() if env_path.exists() else []
keys = {
    "PAPERCLIP_AGENT_TOKEN": agent_token,
    "PAPERCLIP_AGENT_ID": agent_id,
    "PAPERCLIP_COMPANY_ID": company_id,
    # Persist the email too so a future re-seed knows what identity to
    # sign in as (vs. always picking the default).
    "PAPERCLIP_SEED_EMAIL": seed_email,
}
out_lines = []
seen = set()
for line in existing_lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        out_lines.append(line)
        continue
    eq = stripped.find("=")
    if eq < 0:
        out_lines.append(line)
        continue
    k = stripped[:eq].strip()
    if k in keys:
        out_lines.append(f"{k}={keys[k]}")
        seen.add(k)
    else:
        out_lines.append(line)
for k, v in keys.items():
    if k not in seen:
        out_lines.append(f"{k}={v}")

# Persist as a single atomic write - temp file + rename so a partial
# write never leaves the .env truncated.
tmp_path = env_path.with_suffix(env_path.suffix + ".paperclip-init.tmp")
tmp_path.write_text("\n".join(out_lines) + "\n")
try:
    tmp_path.chmod(0o600)
except PermissionError:
    pass
os.replace(tmp_path, env_path)
log(f"step 11b: persisted {len(keys)} keys -> {env_path}")

log("steps 6-11 complete - Paperclip is fully seeded")
PYEOF
}


# --- main ---
log "starting Paperclip full-seed bootstrap"

if ! command -v docker >/dev/null 2>&1; then
    log "ERROR: docker CLI not on PATH — cannot run 'docker exec' against paperclip"
    exit 1
fi

PAPERCLIP_CONTAINER=$(resolve_paperclip_container)
if [[ -z "$PAPERCLIP_CONTAINER" ]]; then
    log "WARN: no paperclip container running — nothing to do (skipping)"
    exit 0
fi
log "resolved paperclip container: $PAPERCLIP_CONTAINER"

if ! wait_for_paperclip_health "$PAPERCLIP_CONTAINER"; then
    exit 1
fi

if already_bootstrapped; then
    log "already fully seeded (PAPERCLIP_AGENT_TOKEN present in $ENV_FILE) — no-op"
    exit 0
fi

# If config.json exists but the invite file doesn't, the principal got as
# far as onboard but bootstrap-ceo never landed (or its output file was
# deleted). Skip the onboard step in that case so we don't reset their
# state, but still run bootstrap-ceo.
if docker exec --user node "$PAPERCLIP_CONTAINER" test -s /paperclip/instances/default/config.json >/dev/null 2>&1; then
    log "config.json already present — skipping 'onboard' step"
else
    paperclip_onboard "$PAPERCLIP_CONTAINER" || exit 1
fi

paperclip_bootstrap_ceo "$PAPERCLIP_CONTAINER" || exit 1

# At this point the invite file is on disk (step 5). Steps 6–11 redeem
# it headlessly + persist PAPERCLIP_AGENT_TOKEN to /opt/alfred/.env. If
# this fails, the dashboard /channels card still renders the click-through
# invite link from step 5 — the principal has a fallback path.
INVITE_URL_CAPTURED=$(head -n 1 "$INVITE_FILE" 2>/dev/null || true)
if [[ -z "$INVITE_URL_CAPTURED" ]]; then
    log "ERROR: invite URL file is empty after bootstrap-ceo — cannot proceed to headless redeem"
    exit 1
fi

SEED_PASSWORD=$(generate_seed_password)
if [[ ${#SEED_PASSWORD} -lt 16 ]]; then
    log "ERROR: failed to generate a seed password (got ${#SEED_PASSWORD} chars)"
    exit 1
fi

if ! run_headless_redeem "$INVITE_URL_CAPTURED" "$SEED_PASSWORD"; then
    log "WARN: headless redeem failed; the dashboard /channels card will fall back to the click-through invite at $INVITE_FILE"
    exit 1
fi

log "Paperclip full-seed bootstrap complete"
exit 0
