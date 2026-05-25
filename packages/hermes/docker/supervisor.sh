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

# Make `main` the sticky default profile so an interactive
# `docker exec -it alfred-black-hermes-1 hermes chat` (or just `hermes`)
# opens the Alfred TUI with persona + MCP tools + vault access, rather
# than the bare stock Hermes default profile under /root/.hermes/.
# Idempotent + best-effort: a future Hermes CLI that changes this
# subcommand's exit code must not crash the supervisor at boot.
hermes profile use main 2>/dev/null || true

# Propagate the openai-codex OAuth credentials across all 3 profiles.
# `hermes auth login` only writes to the sticky-default profile's auth.json
# (now `main`), but the same OAuth token is per-user and works for every
# profile (the ChatGPT subscription is one identity). Without this, the
# heavy profile (onboarding Opus calls) and workers profile (clerk/curator)
# would 401 with "No Codex credentials stored" until manually `hermes -p
# heavy auth login` was run a second + third time.
#
# Rule: if main/auth.json exists, mirror it to workers + heavy whenever
# either is missing OR is smaller (heuristic: empty or env-pointer-only).
# Idempotent — re-running this on every boot is a no-op once the per-profile
# files are sized at-least the main one.
HERMES_ROOT="${HERMES_HOME:-/hermes-state}"
MAIN_AUTH="$HERMES_ROOT/profiles/main/auth.json"
if [[ -f "$MAIN_AUTH" && -s "$MAIN_AUTH" ]]; then
    MAIN_SIZE=$(stat -c%s "$MAIN_AUTH" 2>/dev/null || echo 0)
    for p in workers heavy; do
        P_AUTH="$HERMES_ROOT/profiles/$p/auth.json"
        P_SIZE=0
        [[ -f "$P_AUTH" ]] && P_SIZE=$(stat -c%s "$P_AUTH" 2>/dev/null || echo 0)
        if [[ "$P_SIZE" -lt "$MAIN_SIZE" ]]; then
            cp "$MAIN_AUTH" "$P_AUTH"
            log "propagated main/auth.json -> $p/auth.json (${MAIN_SIZE} bytes)"
        fi
    done
fi

# Consolidate the Alfred-personalised SOUL.md to the file Hermes actually
# reads at gateway boot. Per the Hermes docs
# (https://hermes-agent.nousresearch.com/docs/user-guide/features/personality)
# the persona is loaded from `$HERMES_HOME/SOUL.md` — a single global file,
# NOT per-profile copies. The init container's step 2g lays the personalised
# SOUL into `$HERMES_HOME/profiles/main/SOUL.md`, but Hermes never reads it
# from there. Without this consolidation the live agent boots with the
# stock Nous identity ("You are Hermes Agent…") regardless of how rich the
# main profile's SOUL.md is.
#
# Reasoning: `main` is the user-facing Alfred profile — its SOUL is the
# right one to serve as the global persona.
#
# Guard: non-destructive. We overwrite ONLY if
#   (a) the source is real and non-trivial (>200 bytes), AND
#   (b) the destination is missing, OR smaller, OR contains the stock
#       Nous identity marker (`You are Hermes Agent`).
# A hand-edited $HERMES_HOME/SOUL.md that is neither stock nor smaller
# than the main-profile copy is preserved untouched.
# Install the hermes-lcm plugin into the main profile (main only — workers
# + heavy are stateless / capped-concurrency and LCM has no value there).
# The plugin source is baked at /opt/hermes-lcm by the Dockerfile (pinned
# upstream SHA); we copy it into the persisted profile dir so Hermes
# discovers it under $HERMES_HOME/profiles/main/plugins/. Idempotent —
# `[[ ! -e ... ]]` guard makes re-runs a no-op once installed.
#
# INSTALL CONTRACT (verified against hermes-lcm v0.11.1 + Hermes v2026.5.16):
# This plugin is a filesystem-manifest plugin (`plugin.yaml` + `__init__.py`
# with `register(ctx)`) — NOT a pip package. Hermes discovers it via
# `_scan_directory($HERMES_HOME/plugins/<name>/plugin.yaml)`. When the gateway
# runs under `hermes -p main`, the CLI rewrites HERMES_HOME to
# $HERMES_HOME/profiles/main, so the path below IS the discovery path.
# A `pip install` step would fail (no setup metadata) and is not required.
if [[ -d /opt/hermes-lcm && ! -e "$HERMES_HOME/profiles/main/plugins/hermes-lcm" ]]; then
    mkdir -p "$HERMES_HOME/profiles/main/plugins"
    cp -r /opt/hermes-lcm "$HERMES_HOME/profiles/main/plugins/hermes-lcm"
    log "installed hermes-lcm plugin -> \$HERMES_HOME/profiles/main/plugins/hermes-lcm"
fi

# --- one-alfred plugin (the user-facing continuity layer) -------------------
# Sir's principle: the user must feel they're talking to ONE Alfred, always.
# Hermes' main/workers/heavy session split would otherwise mean a delegate-
# completion message lands in a synthetic session that main has no memory
# of. The one-alfred plugin closes that gap via three hooks:
#   * pre_gateway_dispatch — inject ctrl-api's alfred_journal as context
#     into main's inbound text on every channel-inbound message
#   * pre_llm_call         — journal Sir's inbound message (audit)
#   * post_llm_call        — journal main's outbound reply (audit)
# Source baked at /opt/one-alfred by the Dockerfile. Main only — workers +
# heavy never speak to Sir directly. See packages/ctrl/docs/design/one-alfred.md.
#
# REINSTALL ON IMAGE UPDATE: unlike hermes-lcm which is pinned to a SHA, this
# plugin ships with our image and evolves with our releases. We refresh the
# install on every supervisor boot if the source mtime is newer — keeps
# updates simple (docker compose pull + restart is enough; no manual nuke).
if [[ -d /opt/one-alfred ]]; then
    mkdir -p "$HERMES_HOME/profiles/main/plugins"
    DEST="$HERMES_HOME/profiles/main/plugins/one-alfred"
    if [[ ! -d "$DEST" ]] \
       || [[ /opt/one-alfred/__init__.py -nt "$DEST/__init__.py" ]] \
       || [[ /opt/one-alfred/plugin.yaml -nt "$DEST/plugin.yaml" ]]; then
        rm -rf "$DEST"
        cp -r /opt/one-alfred "$DEST"
        log "installed one-alfred plugin -> \$HERMES_HOME/profiles/main/plugins/one-alfred"
    fi
fi

# --- LCM load-verification (background) --------------------------------------
# hermes-lcm loads silently on success — no startup log line. A broken
# install (wrong dir, partial copy, plugin contract mismatch with the
# running Hermes version) produces ZERO signal in `docker logs hermes`;
# the only symptom is that LCM tools never appear in the agent toolset.
# After main is up, probe the live runtime and log one clear OK / WARNING
# line. Backgrounded so it does not delay the supervise loop.
verify_lcm() {
    local cfg="$HERMES_HOME/profiles/main/config.yaml"
    grep -q "hermes-lcm" "$cfg" 2>/dev/null || return 0

    # Wait for /health (bound at 240s — slightly > HEALTHCHECK start-period).
    local waited=0
    while (( waited < 240 )); do
        curl -fsS --max-time 2 "http://127.0.0.1:18789/health" >/dev/null 2>&1 && break
        sleep 5; waited=$((waited + 5))
    done

    # HTTP probe: lcm_* tools appear only when the LCM engine registered.
    local tools_json
    tools_json="$(curl -fsS --max-time 5 "http://127.0.0.1:18789/v1/tools" 2>/dev/null || true)"
    if [[ -n "$tools_json" ]] && echo "$tools_json" | grep -q '"lcm_'; then
        log "hermes-lcm OK: context engine 'lcm' active on main (lcm_* tools registered)"
        return 0
    fi
    # CLI fallback: `plugins list` is non-interactive (plugins w/o subcommand prompts).
    local plugins_out
    plugins_out="$(hermes -p main plugins list 2>/dev/null || true)"
    if [[ -n "$plugins_out" ]] && echo "$plugins_out" | grep -q "hermes-lcm"; then
        log "hermes-lcm OK: plugin loaded on main (per 'hermes -p main plugins list')"
        return 0
    fi

    log "WARNING: hermes-lcm in main/config.yaml but not loaded after gateway boot."
    log "WARNING:   plugin yaml  : $([[ -f "$HERMES_HOME/profiles/main/plugins/hermes-lcm/plugin.yaml" ]] && echo present || echo MISSING)"
    log "WARNING:   plugin init  : $([[ -f "$HERMES_HOME/profiles/main/plugins/hermes-lcm/__init__.py" ]] && echo present || echo MISSING)"
    log "WARNING:   likely cause : Hermes plugin contract mismatch or HERMES_HOME divergence."
    log "WARNING:   diagnose with: HERMES_PLUGINS_DEBUG=1 hermes -p main plugins list"
}
# Disown so the supervise loop's `wait -n` does not treat verify_lcm's exit
# as a worker death and walk PIDS[] for a spurious match.
verify_lcm &
disown

if [[ -s "$HERMES_HOME/profiles/main/SOUL.md" ]]; then
    MAIN_SOUL_SIZE=$(stat -c%s "$HERMES_HOME/profiles/main/SOUL.md" 2>/dev/null || echo 0)
    HOME_SOUL_SIZE=0
    [[ -f "$HERMES_HOME/SOUL.md" ]] && HOME_SOUL_SIZE=$(stat -c%s "$HERMES_HOME/SOUL.md" 2>/dev/null || echo 0)
    HOME_SOUL_IS_STOCK=0
    if [[ -f "$HERMES_HOME/SOUL.md" ]] && grep -q "You are Hermes Agent" "$HERMES_HOME/SOUL.md" 2>/dev/null; then
        HOME_SOUL_IS_STOCK=1
    fi
    if (( MAIN_SOUL_SIZE > 200 )) && \
       { [[ ! -f "$HERMES_HOME/SOUL.md" ]] \
         || (( HOME_SOUL_SIZE < MAIN_SOUL_SIZE )) \
         || (( HOME_SOUL_IS_STOCK == 1 )); }; then
        cp "$HERMES_HOME/profiles/main/SOUL.md" "$HERMES_HOME/SOUL.md"
        log "consolidated SOUL.md from profiles/main -> \$HERMES_HOME/SOUL.md (${MAIN_SOUL_SIZE} bytes)"
    fi
fi

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
# Two-axis context-file wiring (both required per the Hermes docs):
#   1. TERMINAL_CWD — gateway terminal-tool / cwd-aware prompt assembly.
#   2. Process CWD at launch — Hermes auto-discovers AGENTS.md /
#      CLAUDE.md / .hermes.md / .cursorrules from the PROCESS CWD at
#      gateway boot (user-guide/features/context-files). supervisor.sh
#      inherits tini's `/`, so the per-profile AGENTS.md was never loaded.
# `cd "${PROFILES_DIR}/<p>" && exec hermes …` aligns the gateway's cwd
# with its profile dir. `exec` hands the PID directly to hermes so the
# supervisor's `kill -0 $pid` bookkeeping still tracks the real process.
start_proc "hermes-main"     "cd \"${PROFILES_DIR}/main\"    && TERMINAL_CWD=${PROFILES_DIR}/main    exec hermes -p main gateway run --replace"
start_proc "hermes-workers"  "cd \"${PROFILES_DIR}/workers\" && TERMINAL_CWD=${PROFILES_DIR}/workers exec hermes -p workers gateway run --replace"
start_proc "hermes-heavy"    "cd \"${PROFILES_DIR}/heavy\"   && TERMINAL_CWD=${PROFILES_DIR}/heavy   exec hermes -p heavy gateway run --replace"

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
