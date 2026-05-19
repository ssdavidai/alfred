#!/usr/bin/env bash
# =============================================================================
# supervisor.sh — alfred-black-hermes process supervisor.
#
# Runs FIVE long-lived processes in one container and keeps them alive:
#
#   1. hermes -p main    gateway run   — user-facing chat (Hermes API :18799)
#   2. hermes -p workers gateway run   — background agents (Hermes API :18800)
#   3. hermes-shim (main)              — legacy :18789 → :18799
#   4. hermes-shim (workers)           — legacy :18790 → :18800
#   5. sessionstore-maintenance        — hourly prune + VACUUM on the workers
#                                        SessionStore (replaces the .bak reaper)
#
# tini is PID 1 (see Dockerfile ENTRYPOINT) and reaps zombies; this script
# runs as tini's single child, owns the workers, restarts any that die,
# and forwards SIGTERM/SIGINT for a graceful compose stop.
#
# Profile state (config.yaml, .env, SOUL.md, sessions, skills, the MCP
# bundle) is rendered/deployed by the init container into
# ${HERMES_HOME}/profiles/{main,workers}/ BEFORE this container starts —
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
    for profile in main workers; do
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
    log "both Hermes profiles provisioned under ${PROFILES_DIR}"
}

# =============================================================================
# Boot
# =============================================================================
log "alfred-black-hermes starting — HERMES_HOME=${HERMES_HOME}"
wait_for_profiles

# start_shim — launch a hermes-shim instance scoped to one profile.
# The shim reads its profile, the upstream Hermes API URL, and the API key
# from the environment. The API key is pulled from the profile's rendered
# .env so the shim authenticates to the Hermes API server with the exact
# token the init container generated.
start_shim() {
    local name="$1" profile="$2"
    local env_file="${PROFILES_DIR}/${profile}/.env"
    local api_key internal_port
    api_key="$(grep -E '^API_SERVER_KEY=' "$env_file" | head -1 | cut -d= -f2-)"
    if [[ "$profile" == "main" ]]; then internal_port=18799; else internal_port=18800; fi
    CMDS["$name"]="HERMES_SHIM_PROFILE=${profile} HERMES_API_URL=http://127.0.0.1:${internal_port} HERMES_API_KEY='${api_key}' exec hermes-shim"
    # shellcheck disable=SC2086
    bash -c "${CMDS[$name]}" &
    PIDS["$name"]=$!
    log "started '$name' (pid ${PIDS[$name]}): hermes-shim profile=${profile} → :${internal_port}"
}

# Launch order: gateways first (they own the Hermes API servers), then the
# shims. A shim whose Hermes is not up yet simply reports degraded health and
# retries on the next call — no ordering hazard, but starting gateways first
# shortens the window.
#
# `gateway run --replace` runs in the FOREGROUND (so the supervisor owns the
# process) and `--replace` clears any stale gateway.lock left by a previous
# process — important when this script restarts a crashed gateway.
start_proc "hermes-main"     "exec hermes -p main gateway run --replace"
start_proc "hermes-workers"  "exec hermes -p workers gateway run --replace"

# Give the gateways a head start so the shims' first /health probe is more
# likely to succeed (cosmetic — the shims self-heal regardless).
sleep 3

start_shim "shim-main"    "main"
start_shim "shim-workers" "workers"

# SessionStore maintenance — hourly prune + VACUUM on the workers SessionStore.
# Stdlib-only Python loop; if it crashes the supervise loop restarts it like
# any other process. Self-paces internally (HERMES_MAINT_INTERVAL).
start_proc "sessionstore-maintenance" "exec hermes-sessionstore-maintenance"

# =============================================================================
# Supervise — restart any worker that exits while we are not shutting down.
# =============================================================================
log "all five processes running — entering supervise loop"
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

            case "$name" in
                shim-main)    start_shim "shim-main"    "main" ;;
                shim-workers) start_shim "shim-workers" "workers" ;;
                *)
                    # shellcheck disable=SC2086
                    bash -c "${CMDS[$name]}" &
                    PIDS["$name"]=$!
                    log "restarted '$name' (pid ${PIDS[$name]})"
                    ;;
            esac
        fi
    done
done
