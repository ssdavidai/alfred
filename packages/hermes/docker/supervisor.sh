#!/usr/bin/env bash
# =============================================================================
# supervisor.sh — alfred-black-hermes process supervisor.
#
# Runs THREE long-lived processes in one container and keeps them alive:
#
#   1. hermes -p main    gateway run   — user-facing chat (Hermes API :18789)
#   2. hermes -p workers gateway run   — background agents (Hermes API :18790)
#   3. hermes -p heavy   gateway run   — heavy reasoning (Hermes API :18791)
#
# The hermes-shim was retired in issue #40: the Hermes API server binds the
# canonical ports (:18789 / :18790 / :18791) directly, so callers speak the
# Hermes /v1 API natively — there is no compat layer to supervise.
#
# SessionStore housekeeping is no longer a supervised process: Hermes
# v2026.5.16 natively prunes its SQLite session store and VACUUMs, driven
# by the `session_reset` block in each profile's config.yaml.
#
# tini is PID 1 (see Dockerfile ENTRYPOINT) and reaps zombies; this script
# runs as tini's single child, owns the workers, restarts any that die,
# and forwards SIGTERM/SIGINT for a graceful compose stop.
#
# Profile state (config.yaml, .env, SOUL.md, sessions, skills, the MCP
# bundle) is rendered/deployed by the init container into
# ${HERMES_HOME}/profiles/{main,workers,heavy}/ BEFORE this container starts —
# `init` is a compose `service_completed_successfully` gate. This script
# only waits for that state to appear, then launches.
# =============================================================================
set -uo pipefail

HERMES_HOME="${HERMES_HOME:-/opt/data}"
PROFILES_DIR="${HERMES_HOME}/profiles"

# Per-process restart backoff — a crash-looping process must not hammer the
# provider or spin the CPU. Three rapid restarts then a longer cooldown.
RESTART_DELAY="${HERMES_RESTART_DELAY:-5}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [supervisor] $*"; }

# --- PID bookkeeping ---------------------------------------------------------
declare -A PIDS          # name → pid
declare -A CMDS          # name → command string (eval'd on restart)
declare -A RESTARTS      # name → restart count
SHUTTING_DOWN=0

start_proc() {
    local name="$1"; shift
    local cmd="$*"
    CMDS["$name"]="$cmd"
    # shellcheck disable=SC2086
    bash -c "$cmd" &
    local pid=$!
    PIDS["$name"]=$pid
    log "started '$name' (pid $pid): $cmd"
}

# --- Graceful shutdown -------------------------------------------------------
shutdown() {
    SHUTTING_DOWN=1
    log "received shutdown signal — stopping all processes"
    for name in "${!PIDS[@]}"; do
        local pid="${PIDS[$name]}"
        if kill -0 "$pid" 2>/dev/null; then
            log "  SIGTERM → '$name' (pid $pid)"
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    # Give the Hermes gateways their drain window, then hard-kill stragglers.
    local deadline=$(( $(date +%s) + 70 ))
    while (( $(date +%s) < deadline )); do
        local alive=0
        for name in "${!PIDS[@]}"; do
            kill -0 "${PIDS[$name]}" 2>/dev/null && alive=1
        done
        (( alive == 0 )) && break
        sleep 1
    done
    for name in "${!PIDS[@]}"; do
        local pid="${PIDS[$name]}"
        if kill -0 "$pid" 2>/dev/null; then
            log "  SIGKILL → '$name' (pid $pid) — did not exit in time"
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
    log "shutdown complete"
    exit 0
}
trap shutdown TERM INT

# --- Wait for the init container's profile output ----------------------------
# The init container renders config.yaml + .env into each profile dir. If we
# launch before that exists, Hermes boots with no API key / no MCP config.
wait_for_profiles() {
    local waited=0
    for profile in main workers heavy; do
        local cfg="${PROFILES_DIR}/${profile}/config.yaml"
        local env="${PROFILES_DIR}/${profile}/.env"
        while [[ ! -f "$cfg" || ! -f "$env" ]]; do
            if (( waited == 0 )); then
                log "waiting for init container to render ${profile} profile..."
            fi
            sleep 2
            waited=$((waited + 2))
            if (( waited > 300 )); then
                log "FATAL: profile '${profile}' not provisioned after 300s"
                log "       expected ${cfg} and ${env}"
                exit 1
            fi
        done
    done
    log "all Hermes profiles provisioned under ${PROFILES_DIR}"
}

# =============================================================================
# Boot
# =============================================================================
log "alfred-black-hermes starting — HERMES_HOME=${HERMES_HOME}"
wait_for_profiles

# Launch the three Hermes gateways. Each `gateway run` owns its profile's
# OpenAI-compatible API server, bound to the canonical port (18789 main /
# 18790 workers / 18791 heavy) on 0.0.0.0 — callers reach the /v1 API
# directly. The heavy port is reachable only over the compose network; it is
# not published to the host (no host port binding in docker-compose.yaml).
#
# `gateway run --replace` runs in the FOREGROUND (so the supervisor owns the
# process) and `--replace` clears any stale gateway.lock left by a previous
# process — important when this script restarts a crashed gateway.
#
# TERMINAL_CWD points context-file discovery at each profile dir
# (build_context_files_prompt reads $TERMINAL_CWD, falling back to the
# process cwd `/` otherwise). The init container deploys Alfred's AGENTS.md
# to ${HERMES_HOME}/profiles/<p>/AGENTS.md (entrypoint step 2f); with
# TERMINAL_CWD unset the main gateway looked for /AGENTS.md and the persona /
# standing-rules instructions never reached the agent (F44). Set per-profile
# so each gateway loads its own AGENTS.md from the dir init wrote it to.
start_proc "hermes-main"     "TERMINAL_CWD=${PROFILES_DIR}/main exec hermes -p main gateway run --replace"
start_proc "hermes-workers"  "TERMINAL_CWD=${PROFILES_DIR}/workers exec hermes -p workers gateway run --replace"
start_proc "hermes-heavy"    "TERMINAL_CWD=${PROFILES_DIR}/heavy exec hermes -p heavy gateway run --replace"

# =============================================================================
# Supervise — restart any worker that exits while we are not shutting down.
# =============================================================================
log "all gateway processes running — entering supervise loop"
while true; do
    # Block until SOME child exits. `wait -n` returns that child's status.
    wait -n
    (( SHUTTING_DOWN == 1 )) && continue

    # Identify which process died.
    for name in "${!PIDS[@]}"; do
        pid="${PIDS[$name]}"
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" 2>/dev/null
            code=$?
            RESTARTS["$name"]=$(( ${RESTARTS["$name"]:-0} + 1 ))
            log "process '$name' exited (code ${code}, restart #${RESTARTS[$name]})"

            # Crash-loop guard: after 5 restarts in quick succession the
            # process is broken — surface it by exiting so compose's
            # restart policy / an operator can react, rather than spinning.
            if (( ${RESTARTS[$name]} > 20 )); then
                log "FATAL: '$name' restarted >20 times — giving up, exiting container"
                shutdown
            fi

            sleep "$RESTART_DELAY"
            (( SHUTTING_DOWN == 1 )) && continue

            # shellcheck disable=SC2086
            bash -c "${CMDS[$name]}" &
            PIDS["$name"]=$!
            log "restarted '$name' (pid ${PIDS[$name]})"
        fi
    done
done
