#!/usr/bin/env bash
# =============================================================================
# bootstrap-paperclip.sh — idempotent first-boot bootstrap of the Paperclip
# sidecar so the principal never has to SSH to claim their CEO invite.
#
# Why a separate script (and a separate compose service)?
# -------------------------------------------------------
# The main alfred-init container has no docker.sock and no dependency on
# paperclip's health gate — both of which we need here. So this script ships
# in the same image but is invoked as the entrypoint of a sibling `paperclip-
# init` compose service that:
#   * mounts /var/run/docker.sock RO (we only run `docker exec` / `inspect`)
#   * has alfred_data:/alfred-data so the parsed invite URL becomes a
#     single-source-of-truth file ctrl-api reads (no docker socket needed
#     in ctrl-api to learn the URL).
#   * depends_on: paperclip { condition: service_healthy } so by the time
#     this runs, paperclip's web server is up.
#
# What it does
# ------------
#   1. Wait for the paperclip container to be healthy (up to 2 min). Compose
#      already gates on service_healthy so this is normally a single poll;
#      kept as a belt-and-braces guard against a late health flip.
#   2. Bail out (exit 0, idempotent) when /alfred-data/paperclip-ceo-invite.txt
#      already exists AND paperclip's instance config.json is present inside
#      the container. The principal has already been carried through.
#   3. Run `pnpm paperclipai onboard -y --bind lan` as uid 1000 (`node`).
#      Running as root creates a uid 0 ownership trap on the paperclip
#      volume (live-observed on home 2026-05-27); --user node sidesteps it
#      entirely. -y suppresses interactive prompts; --bind lan trusts
#      compose-network callers.
#   4. Run `pnpm paperclipai auth bootstrap-ceo` (also as `node`). Parse the
#      "Invite URL: https://…" line out of stdout — Paperclip prints this
#      banner verbatim on success.
#   5. Write the parsed URL to /alfred-data/paperclip-ceo-invite.txt with
#      0644 so ctrl-api (root) and the rest of the stack can read it. That
#      file is what ctrl-api surfaces in /api/v1/channels/paperclip/status.
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
# =============================================================================
set -euo pipefail

LOG_PREFIX="[paperclip-bootstrap]"
log() { echo "$LOG_PREFIX $*"; }

INVITE_FILE="${INVITE_FILE:-/alfred-data/paperclip-ceo-invite.txt}"
WAIT_TIMEOUT_SECS="${WAIT_TIMEOUT_SECS:-120}"
WAIT_INTERVAL_SECS="${WAIT_INTERVAL_SECS:-5}"

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

# Idempotency probe — true when we've already carried this tenant through
# the bootstrap. The two conditions together rule out a partial first-run
# (e.g. invite file written but the container's config.json never landed
# because pnpm crashed mid-way).
already_bootstrapped() {
    local container="$1"
    if [[ ! -s "$INVITE_FILE" ]]; then
        return 1
    fi
    if ! docker exec --user node "$container" test -s /paperclip/instances/default/config.json >/dev/null 2>&1; then
        return 1
    fi
    return 0
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
paperclip_bootstrap_ceo() {
    local container="$1"
    local out_file
    out_file=$(mktemp)
    local attempts=3
    for attempt in $(seq 1 $attempts); do
        log "running 'pnpm paperclipai auth bootstrap-ceo' (attempt $attempt/$attempts, as node)…"
        if docker exec --user node "$container" pnpm paperclipai auth bootstrap-ceo >"$out_file" 2>&1; then
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

# --- main ---
log "starting Paperclip auto-bootstrap"

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

if already_bootstrapped "$PAPERCLIP_CONTAINER"; then
    log "already bootstrapped (invite file + config.json present) — no-op"
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

log "Paperclip auto-bootstrap complete"
exit 0
