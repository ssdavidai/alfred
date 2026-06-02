#!/usr/bin/env bash
# =============================================================================
# supervisor.sh — alfred-black-hermes process supervisor.
#
# Reads /hermes-state/profiles/_registry.json (written by the init container
# + ctrl-api on every profile create/archive — #120 Lane II) and keeps a
# Hermes gateway alive per registered profile:
#
#   1. hermes -p main    gateway run   — user-facing chat (Hermes API :18789)
#   2. hermes -p workers gateway run   — background agents (Hermes API :18790)
#   3. hermes -p heavy   gateway run   — heavy reasoning (Hermes API :18791)
#   4. hermes -p codex-builder gateway run — sealed builder (Hermes API
#      :18793) — ONLY when ENABLE_CODEX_BUILDER=true. The profile dir
#      is always rendered by the init container; this script just decides
#      whether to launch a gateway against it. Drops to uid 10001 via
#      `setpriv --reuid 10001`. See docs/codex-builder-runtime.md §2.
#   5..N. Any user-facing profile created via ctrl-api's POST
#         /api/v1/agent-profiles. Each gets a gateway on its allocated
#         port (18794..18799). After /health = 200 the supervisor POSTs
#         status='running' back to ctrl-api so the registry row reflects
#         the live state.
#
# SIGUSR1 — reconcile against the latest registry without a full restart.
# ctrl-api sends this signal after every create/archive. The handler diffs
# the on-disk registry against the live PIDS[] map: missing profiles get
# spawned, archived profiles get a clean SIGTERM.
#
# The hermes-shim was retired in issue #40: the Hermes API server binds the
# canonical ports (:18789 / :18790 / :18791 / :18793) directly, so callers
# speak the Hermes /v1 API natively — there is no compat layer to supervise.
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
# bundle) is rendered/deployed by the init container BEFORE this
# container starts — `init` is a compose `service_completed_successfully`
# gate. This script only waits for that state to appear, then launches.
# =============================================================================
set -uo pipefail

HERMES_HOME="${HERMES_HOME:-/opt/data}"
PROFILES_DIR="${HERMES_HOME}/profiles"

# Sir's decision #2: codex-builder is rendered on every tenant but ONLY
# launched where the flag is true. Reads the runtime container env (set
# from docker-compose's `environment:` block + the tenant /opt/alfred/.env).
# Treat the empty string, "0", "false", "no", "off" as false; anything else
# is true. Defaults to false — every tenant that doesn't explicitly opt in
# gets the rendered profile dir + a silent no-launch.
ENABLE_CODEX_BUILDER_RAW="${ENABLE_CODEX_BUILDER:-false}"
case "${ENABLE_CODEX_BUILDER_RAW,,}" in
    true|1|yes|on)  ENABLE_CODEX_BUILDER=1 ;;
    *)              ENABLE_CODEX_BUILDER=0 ;;
esac

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

# --- SIGUSR1 reconcile trap (#120 Lane II) -----------------------------------
# ctrl-api sends SIGUSR1 after every profile create/archive. The handler
# re-reads /hermes-state/profiles/_registry.json and:
#   * spawns a hermes-<slug> gateway for any newly-registered profile.
#   * SIGTERMs the gateway of any registered-but-now-archived profile.
# Idempotent — running it on a registry that exactly matches the live
# PIDS[] is a no-op.
#
# Implementation note: bash traps run between commands in the main loop,
# not from anywhere; long-running operations inside a trap can stall the
# supervise loop's wait -n. We keep the body short and offload the
# /health probe to a background subshell.
reconcile_registry() {
    log "SIGUSR1 received — reconciling registry"
    local seen_slugs=""
    while IFS=$'\t' read -r slug port _ _; do
        [[ -z "$slug" ]] && continue
        seen_slugs="${seen_slugs} ${slug}"
        if [[ -z "${REGISTRY_LAUNCHED[$slug]:-}" ]]; then
            # New profile — spawn it. codex-builder cannot be added at
            # runtime (the egress-jail + setpriv path runs at boot).
            if [[ "$slug" == "codex-builder" ]]; then
                log "reconcile: skipping codex-builder (boot-only launch)"
                continue
            fi
            log "reconcile: spawning new profile '${slug}' on port ${port}"
            start_registered_profile "$slug" "$port"
            # Probe + status callback for the new profile in the background.
            probe_and_notify "$slug" "$port" &
            disown
        fi
    done < <(read_registry)

    # SIGTERM any launched profile that is no longer in the registry.
    for slug in "${!REGISTRY_LAUNCHED[@]}"; do
        if [[ "$slug" == "codex-builder" ]]; then
            continue  # never tear down codex-builder via reconcile
        fi
        if [[ " ${seen_slugs} " != *" ${slug} "* ]]; then
            local proc_name="hermes-${slug}"
            local pid="${PIDS[$proc_name]:-}"
            if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
                log "reconcile: SIGTERM '${proc_name}' (pid ${pid}) — profile archived"
                kill -TERM "$pid" 2>/dev/null || true
                # Mark as not-launched so a future re-add can spawn fresh.
                # Don't unset PIDS[] here; the supervise loop walks it on
                # exit to record the death.
            fi
            unset 'REGISTRY_LAUNCHED['"$slug"']'
            unset 'REGISTRY_PORT['"$slug"']'
        fi
    done
}
trap reconcile_registry USR1

# --- Registry-driven profile enumeration (#120 Lane II) ----------------------
# Reads /hermes-state/profiles/_registry.json (written by init container +
# ctrl-api) and emits tab-separated `slug\tport\tmodel\tis_reserved` per
# active profile to stdout. Uses python3 (already in the hermes image —
# Hermes is python). Falls back to the legacy hard-coded 4-profile set on
# any read failure so a missing-file boot still has known-good defaults.
REGISTRY_FILE="${PROFILES_DIR}/_registry.json"

read_registry() {
    if [[ -f "$REGISTRY_FILE" ]]; then
        python3 - "$REGISTRY_FILE" <<'PY' || _registry_fallback
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
    profiles = data.get("profiles", [])
    for p in profiles:
        slug = str(p.get("slug", "")).strip()
        port = int(p.get("api_server_port", 0))
        model = str(p.get("model", "")).strip()
        reserved = "1" if p.get("is_reserved") else "0"
        if not slug or not port:
            continue
        print(f"{slug}\t{port}\t{model}\t{reserved}")
except Exception as e:
    sys.stderr.write(f"[supervisor] registry read failed: {e}\n")
    sys.exit(1)
PY
    else
        _registry_fallback
    fi
}

_registry_fallback() {
    log "WARN: registry file ${REGISTRY_FILE} missing — using hard-coded reserved set"
    echo -e "main\t18789\tx-ai/grok-4.3\t1"
    echo -e "workers\t18790\topenai/gpt-4.1-nano\t1"
    echo -e "heavy\t18791\tanthropic/claude-opus-4-6\t1"
    if (( ENABLE_CODEX_BUILDER == 1 )); then
        echo -e "codex-builder\t18793\tgpt-5-codex\t1"
    fi
}

# --- Wait for the init container's profile output ----------------------------
# The init container renders config.yaml + .env into each profile dir. If we
# launch before that exists, Hermes boots with no API key / no MCP config.
wait_for_profiles() {
    local waited=0
    # Wait for the registry file first — init writes it before the
    # per-profile renders below, so its presence is the signal that
    # rendering has begun. Fall back to the legacy 4-profile wait when
    # missing for back-compat with an older init image.
    while [[ ! -f "$REGISTRY_FILE" ]]; do
        if (( waited == 0 )); then
            log "waiting for init container to write ${REGISTRY_FILE}..."
        fi
        sleep 2
        waited=$((waited + 2))
        if (( waited > 60 )); then
            log "WARN: registry file ${REGISTRY_FILE} did not appear after ${waited}s — proceeding with hard-coded fallback"
            break
        fi
    done

    # Now wait for the per-profile config.yaml + .env to exist for every
    # slug the registry tells us about.
    local profiles_seen=""
    while IFS=$'\t' read -r slug port _ _; do
        [[ -z "$slug" ]] && continue
        # codex-builder is a special case — its launch is flag-gated
        # below; we still want its config rendered, but don't block on
        # it when the flag is off.
        if [[ "$slug" == "codex-builder" && "$ENABLE_CODEX_BUILDER" != "1" ]]; then
            continue
        fi
        local cfg="${PROFILES_DIR}/${slug}/config.yaml"
        local env="${PROFILES_DIR}/${slug}/.env"
        local profile_wait=0
        while [[ ! -f "$cfg" || ! -f "$env" ]]; do
            if (( profile_wait == 0 )); then
                log "waiting for init container to render ${slug} profile..."
            fi
            sleep 2
            profile_wait=$((profile_wait + 2))
            if (( profile_wait > 300 )); then
                log "FATAL: profile '${slug}' not provisioned after 300s"
                log "       expected ${cfg} and ${env}"
                exit 1
            fi
        done
        profiles_seen="${profiles_seen} ${slug}"
    done < <(read_registry)
    log "all Hermes profiles provisioned under ${PROFILES_DIR} (codex-builder enabled=${ENABLE_CODEX_BUILDER}; profiles:${profiles_seen})"
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
#
# Sir's decision #1 (docs/codex-builder-runtime.md §11.1, overruling the
# design-doc recommendation): codex-builder uses the SHARED openai-codex
# auth, NOT a separate `codex login --device-auth` ritual per tenant. So
# when ENABLE_CODEX_BUILDER=1 AND the profile dir exists, we mirror the
# same main/auth.json into:
#   - profiles/codex-builder/auth.json (Hermes' LLM provider auth — what
#     the supervising agent uses for its own /v1/responses calls)
#   - profiles/codex-builder/.codex/auth.json (the codex CLI's auth file —
#     the CLI reads $CODEX_HOME/auth.json, which the .env points at
#     /hermes-state/profiles/codex-builder/.codex).
# Same OAuth token, two file locations, one shared ChatGPT identity.
# Survives `docker compose pull` because hermes_data is a named volume.
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

    # codex-builder mirror — gated on the flag + the rendered profile.
    if (( ENABLE_CODEX_BUILDER == 1 )) \
       && [[ -d "$HERMES_ROOT/profiles/codex-builder" ]]; then
        CB_AUTH="$HERMES_ROOT/profiles/codex-builder/auth.json"
        CB_SIZE=0
        [[ -f "$CB_AUTH" ]] && CB_SIZE=$(stat -c%s "$CB_AUTH" 2>/dev/null || echo 0)
        if [[ "$CB_SIZE" -lt "$MAIN_SIZE" ]]; then
            cp "$MAIN_AUTH" "$CB_AUTH"
            log "propagated main/auth.json -> codex-builder/auth.json (${MAIN_SIZE} bytes, Hermes-LLM auth)"
        fi
        # PR 4: the codex-builder gateway runs under uid 10001 and cannot
        # read root-owned files. Re-chown after every copy so a fresh-on-
        # this-boot mirror is immediately readable by the gateway. The
        # init container also chowns the whole profile dir, but supervisor
        # boots AFTER init so a copy here racing against init's chown
        # would leave the file root-owned if we don't repeat.
        chown 10001:10001 "$CB_AUTH" 2>/dev/null || true
        chmod 0600 "$CB_AUTH" 2>/dev/null || true

        # Codex CLI's own auth — reads $CODEX_HOME/auth.json. .env sets
        # CODEX_HOME=/hermes-state/profiles/codex-builder/.codex.
        mkdir -p "$HERMES_ROOT/profiles/codex-builder/.codex"
        chown 10001:10001 "$HERMES_ROOT/profiles/codex-builder/.codex" 2>/dev/null || true
        chmod 0700 "$HERMES_ROOT/profiles/codex-builder/.codex" 2>/dev/null || true
        CLI_AUTH="$HERMES_ROOT/profiles/codex-builder/.codex/auth.json"
        CLI_SIZE=0
        [[ -f "$CLI_AUTH" ]] && CLI_SIZE=$(stat -c%s "$CLI_AUTH" 2>/dev/null || echo 0)
        if [[ "$CLI_SIZE" -lt "$MAIN_SIZE" ]]; then
            cp "$MAIN_AUTH" "$CLI_AUTH"
            log "propagated main/auth.json -> codex-builder/.codex/auth.json (${MAIN_SIZE} bytes, codex-CLI auth)"
        fi
        chown 10001:10001 "$CLI_AUTH" 2>/dev/null || true
        chmod 0600 "$CLI_AUTH" 2>/dev/null || true
    fi
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
#
# .env source-and-export contract (the 2026-05-28 hardening):
#   `set -a; . "${PROFILES_DIR}/<p>/.env"; set +a` reads the per-profile
#   .env rendered by the init container and exports every KEY=VALUE pair
#   into the gateway's process environment BEFORE `exec hermes`. Without
#   this the running gateway depends entirely on Hermes' internal
#   `load_hermes_dotenv()` (gateway/run.py imports `hermes_cli.env_loader`),
#   which is fragile in two ways:
#     (a) the profile override (hermes_cli/main.py:_apply_profile_override)
#         must fire so HERMES_HOME points at the profile dir, otherwise
#         the wrong .env loads — a future CLI refactor could regress this
#         silently.
#     (b) `/proc/<pid>/environ` shows the gateway's initial env, not
#         os.environ after Python loads it; operators (and ctrl-api's
#         channels code, see channels_paperclip.ts:readHermesMainApiKey)
#         that diagnose 401s by inspecting /proc see EMPTY API_SERVER_KEY
#         and conclude the gateway boots unauthenticated. Sourcing the
#         file here makes the auth key explicit, visible, and unambiguous.
#   Sir 2026-05-28 — this hardening was prompted by a live paperclip-MCP
#   heartbeat 401 storm on home where the running gateway accepted the
#   profile key but /proc/<hermes-pid>/environ looked empty, sending
#   operators chasing a phantom config-load bug for an hour.
#
# Idempotent + crash-loop-safe: `start_proc` re-eval's the full command
# string on each restart, so a profile .env edited after first boot is
# picked up the next time the supervisor respawns that gateway.
# #120 Lane II — registry-driven launch. Build a `hermes-<slug>` start_proc
# per non-codex-builder profile in the registry, plus track every launched
# slug so the SIGUSR1 reconciler can diff against the live PIDS set.
declare -A REGISTRY_PORT=()
declare -A REGISTRY_LAUNCHED=()  # slug → 1 once start_proc has fired

# probe_and_notify(slug, port) — poll /health on the given port and POST
# back to ctrl-api when it goes 200, flipping the registry row's status
# from 'pending' to 'running'. Backgrounded by the caller — runs up to
# ~60s before giving up (the next supervisor reconcile / restart will
# retry).
#
# Auth: the gateway token at /alfred-data/.gateway-token IS the AAS_API_KEY
# the rest of the stack uses to call ctrl-api (init writes the same value
# into both). Read it inline rather than baking it into compose so a token
# rotation doesn't need a hermes restart.
probe_and_notify() {
    local slug="$1"
    local port="$2"
    local waited=0
    while (( waited < 60 )); do
        if curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
            log "probe: '${slug}' /health OK on :${port} after ${waited}s"
            # ctrl-api authenticates with AAS_API_KEY (64-char value), NOT
            # the gateway token (/alfred-data/.gateway-token is the 43-char
            # API_SERVER_KEY for the Hermes gateways themselves, a different
            # surface). The init container renders AAS_API_KEY into each
            # profile's .env (hermes-profile.env.njk). Read main's copy so
            # the supervisor can talk to ctrl-api without taking a dep on
            # the gateway-token surface.
            local token=""
            if [[ -r "${PROFILES_DIR}/main/.env" ]]; then
                token="$(grep -E '^AAS_API_KEY=' "${PROFILES_DIR}/main/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
            fi
            if [[ -n "$token" ]]; then
                if curl -fsS --max-time 5 \
                        -X POST \
                        -H "Authorization: Bearer ${token}" \
                        -H "Content-Type: application/json" \
                        -d '{"status":"running"}' \
                        "http://ctrl-api:3100/api/v1/agent-profiles/${slug}/status" \
                        >/dev/null 2>&1; then
                    log "probe: notified ctrl-api '${slug}' status=running"
                else
                    log "probe: WARN ctrl-api status notify failed for '${slug}' — registry row stays at last value"
                fi
            else
                log "probe: WARN AAS_API_KEY not in main/.env — skipping ctrl-api notify for '${slug}'"
            fi
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
    done
    log "probe: '${slug}' /health did NOT respond on :${port} within 60s"
    return 1
}

start_registered_profile() {
    local slug="$1"
    local port="$2"
    # codex-builder uses a separate setpriv+egress-jail path further
    # down. Skip here so the generic launcher doesn't race the special
    # one.
    if [[ "$slug" == "codex-builder" ]]; then
        return 0
    fi
    if [[ -n "${REGISTRY_LAUNCHED[$slug]:-}" ]]; then
        return 0  # already running
    fi
    local profile_dir="${PROFILES_DIR}/${slug}"
    # #120 Lane IIb — when ctrl-api registers a new profile at RUNTIME
    # (after init exited), there's no operator step to fire a re-render.
    # The supervisor self-renders the missing profile dir inline so the
    # principal-creates-profile flow is end-to-end automatic.
    #
    # render_profile_dir is idempotent — calling it for an already-
    # rendered profile is harmless (render_hermes.py preserves an existing
    # operator-owned config.yaml; render_mcp_servers.py is ADD-only). On
    # render failure we log loudly and skip launch; the next reconcile
    # tick will retry without bringing down the live profiles.
    if [[ ! -f "${profile_dir}/.env" || ! -f "${profile_dir}/config.yaml" ]]; then
        log "INFO: profile dir missing for '${slug}' — rendering inline (port=${port})"
        if ! render_profile_dir "$slug" "$port"; then
            log "ERROR: inline render failed for '${slug}' — skipping launch (will retry on next reconcile)"
            return 0
        fi
        if [[ ! -f "${profile_dir}/.env" || ! -f "${profile_dir}/config.yaml" ]]; then
            log "ERROR: inline render of '${slug}' completed but config.yaml/.env still missing — skipping launch"
            return 0
        fi
    fi
    REGISTRY_PORT["$slug"]="$port"
    REGISTRY_LAUNCHED["$slug"]=1
    start_proc "hermes-${slug}" \
        "cd \"${profile_dir}\" && set -a && . \"${profile_dir}/.env\" && set +a && TERMINAL_CWD=${profile_dir} exec hermes -p ${slug} gateway run --replace"
}

# --- Runtime self-render (#120 Lane IIb) -------------------------------------
# When ctrl-api registers a NEW profile after init has exited, the supervisor
# is the only process around to render the profile dir. We invoke the SAME
# two renderer scripts the init container runs, with the same env contract,
# so a runtime-rendered profile is byte-identical to one rendered at boot.
#
# Inputs from the registry: slug + port. Model comes from the registry too;
# look it up from REGISTRY_FILE in case the SIGUSR1 reconciler called us
# without it. Renderer environment:
#   * HERMES_VAULT_PATH        — same default as init (/vault)
#   * HERMES_RUNTIME_PROFILE_DIR — bake the runtime view into config.yaml
#                                  (matches init's HERMES_RUNTIME_HOME plumbing)
#   * HERMES_RENDER_PORT       — registry-allocated port (18794..18799)
#   * HERMES_RENDER_MODEL      — registry-allocated model
#   * CTRL_API_URL             — http://ctrl-api:3100 (compose-network)
#   * STATE_DB_PATH            — unset; supervisor has no /ctrl-data mount.
#                                render_mcp_servers degrades gracefully to
#                                "all servers direct" when the path is
#                                missing — same as a fresh-tenant first boot.
#
# Provider keys, AAS_API_KEY, COMPOSIO_*: the hermes runtime container's
# compose env carries OPENROUTER_API_KEY + ANTHROPIC_API_KEY directly; the
# rest live in main/.env (rendered by init at boot). We source main/.env
# into the renderer subshell BEFORE invoking render_hermes so the new
# profile's .env carries the same AAS_API_KEY / OPENAI_API_KEY / COMPOSIO_*
# values as main. Without this, the rendered .env would have those keys
# blank and the new gateway would 401 on every ctrl-api call.
#
# Falls back to "render scripts not baked" (older image) by logging a clear
# error and returning 1 — the caller skips launch; the operator can still
# trigger init manually as the explicit-fallback path.
render_profile_dir() {
    local slug="$1"
    local port="$2"
    local render_dir="${HERMES_RENDER_DIR:-/opt/hermes-init}"
    local hermes_template_dir="${HERMES_TEMPLATE_DIR:-/opt/hermes-init/templates}"
    local gateway_token_file="${OPENCLAW_GATEWAY_TOKEN_FILE:-/alfred-data/.gateway-token}"
    local profile_dir="${PROFILES_DIR}/${slug}"

    if [[ ! -x "${render_dir}/render_hermes.py" ]]; then
        log "render: missing ${render_dir}/render_hermes.py — older image?"
        return 1
    fi
    if [[ ! -f "${hermes_template_dir}/hermes-config.yaml.njk" \
       || ! -f "${hermes_template_dir}/hermes-profile.env.njk" ]]; then
        log "render: missing .njk templates under ${hermes_template_dir}"
        return 1
    fi
    if [[ ! -r "${gateway_token_file}" ]]; then
        log "render: gateway token file ${gateway_token_file} unreadable"
        return 1
    fi
    local gateway_token
    gateway_token="$(tr -d '[:space:]' < "${gateway_token_file}")"
    if [[ -z "${gateway_token}" ]]; then
        log "render: gateway token file ${gateway_token_file} is empty"
        return 1
    fi

    # Look up the model for this slug from the registry — supervisor only
    # receives slug+port through the reconcile path; the model is in the
    # registry JSON.
    local model=""
    if [[ -f "${REGISTRY_FILE}" ]]; then
        model="$(python3 - "${REGISTRY_FILE}" "${slug}" <<'PY' || true
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
    target = sys.argv[2]
    for p in data.get("profiles", []):
        if str(p.get("slug", "")).strip() == target:
            print(str(p.get("model", "")).strip())
            break
except Exception:
    pass
PY
)"
    fi

    mkdir -p "${profile_dir}"
    # Source main/.env so the renderer inherits AAS_API_KEY / OPENAI_API_KEY /
    # COMPOSIO_* / ALFRED_PRIME / CROSS_TENANT_PEERS — same values as the
    # principal-facing profile. The hermes container's compose env only
    # carries OPENROUTER_API_KEY + ANTHROPIC_API_KEY directly; everything
    # else propagates through main/.env at init time.
    (
        if [[ -r "${PROFILES_DIR}/main/.env" ]]; then
            set -a
            # shellcheck disable=SC1090,SC1091
            . "${PROFILES_DIR}/main/.env" || true
            set +a
        fi
        export HERMES_VAULT_PATH="${HERMES_VAULT_PATH:-/vault}"
        export HERMES_RUNTIME_PROFILE_DIR="${profile_dir}"
        export HERMES_RENDER_PORT="${port}"
        export HERMES_RENDER_MODEL="${model}"
        export CTRL_API_URL="${CTRL_API_URL:-http://ctrl-api:3100}"
        if ! python3 "${render_dir}/render_hermes.py" \
                "${slug}" \
                "${profile_dir}" \
                "${hermes_template_dir}" \
                "${gateway_token}"; then
            echo "render_hermes.py failed for ${slug}" >&2
            exit 1
        fi
        # ADD-only mutator for the MCP server backfill, identical to init's
        # call. STATE_DB_PATH is intentionally not set — supervisor has no
        # /ctrl-data mount so render_mcp_servers degrades to "no disposition
        # overrides" (same fallback as a fresh-tenant first boot).
        PROFILE_DIR="${profile_dir}" \
        HERMES_RUNTIME_PROFILE_DIR="${profile_dir}" \
        CTRL_API_URL="${CTRL_API_URL:-http://ctrl-api:3100}" \
            python3 "${render_dir}/render_mcp_servers.py" "${slug}" \
            || echo "render_mcp_servers.py failed for ${slug} (non-fatal)" >&2
    )
    local rc=$?
    if (( rc != 0 )); then
        log "render: render_hermes.py exited ${rc} for '${slug}'"
        return 1
    fi
    log "render: '${slug}' rendered into ${profile_dir} (port=${port}, model=${model:-<default>})"
    return 0
}

# Initial launch — iterate the registry once.
# ANCHOR: BOOT_LAUNCH_LOOP — supervisor tests pin to this comment.
while IFS=$'\t' read -r slug port _ _; do
    [[ -z "$slug" ]] && continue
    start_registered_profile "$slug" "$port"
done < <(read_registry)

# Fire one probe per launched profile in the background. Each waits for
# /health and POSTs status=running back to ctrl-api so the agent_profile
# row reflects the live process. Disowned so the supervise loop's `wait -n`
# does not catch their completion as a child death.
for slug in "${!REGISTRY_LAUNCHED[@]}"; do
    if [[ "$slug" == "codex-builder" ]]; then
        continue  # codex-builder probe is the special verify_lcm path
    fi
    port="${REGISTRY_PORT[$slug]:-}"
    if [[ -z "$port" ]]; then
        continue
    fi
    probe_and_notify "$slug" "$port" &
    disown
done

# --- codex-builder gateway (Sir's decision #2 — flag-gated, home only) -------
# The 4th profile, only launched when ENABLE_CODEX_BUILDER=1. Renders fleet-
# wide via the init container, but a non-home tenant never starts the process.
#
# PR 4 hardening:
#   1. Egress allowlist — iptables OUTPUT rules scoped --uid-owner 10001
#      that allow OpenAI / GitHub / npm / PyPI / crates.io and REJECT
#      everything else. Installed BEFORE the gateway starts so the first
#      `codex exec` already runs under the constraint. Requires the
#      NET_ADMIN cap (added in PR 2 docker-compose.yaml).
#   2. setpriv uid drop — `setpriv --reuid 10001 --regid 10001
#      --clear-groups --reset-env` swaps the gateway to uid 10001 and
#      clears the inherited environment so OPENROUTER_API_KEY,
#      AAS_API_KEY, COMPOSIO_*, etc. (which the docker-compose service
#      surfaces into the container's initial env) CANNOT leak into the
#      sealed gateway's process env. We re-establish the minimum
#      (PATH, HOME, TERM) and source the profile's positive-allowlist
#      .env on top.
#
# `cd ${PROFILES_DIR}/codex-builder` lines up AGENTS.md auto-discovery and
# matches the established pattern. `set -a; . .env; set +a` source-and-
# exports the codex-builder positive-allowlist (the 2026-05-28 hardening
# from PR #92) — the .env's CODEX_HOME / CODEX_WORKSPACE_ROOT / GIT_SSH_
# COMMAND flow through to the gateway process here.
if (( ENABLE_CODEX_BUILDER == 1 )); then
    # 1. Install the egress allowlist BEFORE launching the gateway.
    # `codex-builder-setup-egress.sh` is baked into /usr/local/bin in the
    # Dockerfile (PR 4); it expects NET_ADMIN. Failure here SHOULD fail
    # the whole supervisor — a builder gateway running without the egress
    # filter could exfiltrate to any host (the persona prompt is the only
    # remaining fence, and that's a soft one). Run as root (the supervisor
    # itself runs as root inside the container) so iptables can mutate the
    # OUTPUT chain.
    if /usr/local/bin/codex-builder-setup-egress.sh; then
        log "codex-builder egress jail installed (--uid-owner 10001, default REJECT)"
    else
        log "FATAL: codex-builder egress jail setup failed (exit $?) — refusing to launch gateway"
        log "       check 'cap_add: NET_ADMIN' on the hermes service in docker-compose.yaml,"
        log "       and that /usr/local/bin/codex-builder-setup-egress.sh is executable."
        # Don't `exit` the supervisor — main/workers/heavy are already up
        # and we don't want to take them down on a codex-builder-specific
        # failure. Just skip the codex-builder gateway and log loudly.
        ENABLE_CODEX_BUILDER=0
    fi
fi

if (( ENABLE_CODEX_BUILDER == 1 )); then
    # 2. setpriv uid drop. The chain:
    #    setpriv --reuid 10001 --regid 10001 --clear-groups --reset-env
    #      env -i (already done by --reset-env)
    #      PATH=/usr/local/bin:/usr/bin:/bin
    #      HOME=$PROFILES_DIR/codex-builder
    #      TERM=$TERM (preserve if set; else dumb)
    #      HERMES_HOME=$HERMES_HOME (Hermes' profile resolution root)
    #      cd $HOME
    #      source $HOME/.env  (positive-allowlist)
    #      exec hermes -p codex-builder gateway run --replace
    # `bash -c` is what start_proc invokes — we put the whole chain in
    # one quoted command string. `--clear-groups` drops the supplementary
    # group set (default gid 10000 would be inherited from the container
    # default user); `--reset-env` wipes the inherited env, which is the
    # crucial bit for keeping OPENROUTER_API_KEY etc. out of the gateway.
    #
    # HERMES_HOME passthrough is REQUIRED — without it Hermes' CLI
    # falls back to ~/.hermes which doesn't contain our profile dir,
    # giving "Error: Profile 'codex-builder' does not exist". Live-
    # observed 2026-05-28 right after the SETUID cap fix. We pass the
    # current supervisor's HERMES_HOME through verbatim; it points at
    # the hermes_data volume both views share.
    CODEX_HOME_DIR="${PROFILES_DIR}/codex-builder"
    start_proc "hermes-codex-builder" \
        "exec setpriv --reuid=10001 --regid=10001 --clear-groups --reset-env \
            env \
              PATH=/usr/local/bin:/usr/bin:/bin \
              HOME=\"${CODEX_HOME_DIR}\" \
              TERM=\"\${TERM:-dumb}\" \
              HERMES_HOME=\"${HERMES_HOME}\" \
              bash -c 'cd \"${CODEX_HOME_DIR}\" \
                       && set -a && . \"${CODEX_HOME_DIR}/.env\" && set +a \
                       && TERMINAL_CWD=\"${CODEX_HOME_DIR}/workspace\" \
                          exec hermes -p codex-builder gateway run --replace'"
    # #120 Lane II — mark codex-builder as already-launched so the SIGUSR1
    # reconciler doesn't double-start it via the generic path.
    REGISTRY_LAUNCHED["codex-builder"]=1
    REGISTRY_PORT["codex-builder"]=18793
    log "codex-builder gateway enabled (ENABLE_CODEX_BUILDER=1) — launching on :18793 as uid 10001"
else
    log "codex-builder gateway disabled (ENABLE_CODEX_BUILDER!=1) — profile dir is rendered but no process launched"
fi

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

            # #120 Lane II — re-probe + re-notify after restart so the
            # registry row's status flips back to 'running' once the
            # rebooted gateway is healthy. Only for the registry-driven
            # gateways (hermes-<slug>); codex-builder runs verify_lcm
            # separately.
            if [[ "$name" == hermes-* && "$name" != "hermes-codex-builder" ]]; then
                restart_slug="${name#hermes-}"
                restart_port="${REGISTRY_PORT[$restart_slug]:-}"
                if [[ -n "$restart_port" ]]; then
                    probe_and_notify "$restart_slug" "$restart_port" &
                    disown
                fi
            fi
        fi
    done
done
