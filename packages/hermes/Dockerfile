# =============================================================================
# alfred-black-hermes — the single AI runtime image.
#
# Replaces BOTH OpenClaw containers (`openclaw` :18789 + `openclaw-workers`
# :18790). Hermes profiles give each side its own API port, key, config and
# SQLite SessionStore — the same isolation boundary, at near-zero cost: one
# image, one extra ~150 MB Python process instead of a whole second Node
# container.
#
# The container runs TWO supervised processes (see docker/supervisor.sh):
#   hermes -p main    gateway run   — user-facing chat, Hermes API on :18789
#   hermes -p workers gateway run   — background agents, Hermes API on :18790
# The hermes-shim was retired (issue #40): the Hermes API server binds the
# canonical ports directly; callers speak the Hermes /v1 API natively.
#
# BUILD CONTEXT: the alfred-black monorepo root. All COPY paths are
# repo-relative (matches the init container's `context: .` convention).
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — build the 5-app MCP stdio bundle from packages/mcp-server.
#
# Same TypeScript source the HTTP alfred-mcp-server is built from. The
# Hermes runtime spawns each of the 5 apps (alfred/sure/plane/vaultwarden/
# execute) as a stdio MCP child process. We ship the compiled bundle so the
# runtime image needs no build toolchain for it.
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS mcp-builder
WORKDIR /mcp-server
COPY packages/mcp-server/package.json packages/mcp-server/package-lock.json* ./
RUN npm ci --prefer-offline --no-audit --no-fund
COPY packages/mcp-server/tsconfig.json ./
COPY packages/mcp-server/src ./src
RUN npm run build
# Result: /mcp-server/dist/ + /mcp-server/node_modules/.

# -----------------------------------------------------------------------------
# Stage 2 — the Hermes runtime image.
# -----------------------------------------------------------------------------
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive

# --- System dependencies -----------------------------------------------------
# - tini           : PID-1 init that reaps the zombie children the MCP stdio
#                     subprocesses, git, node, etc. would otherwise leave.
# - git            : pip installs Hermes from a git ref.
# - build-essential, gcc, python3-dev, libffi-dev : native wheels in the
#                     Hermes dependency tree (pydantic-core, etc.).
# - ripgrep        : Hermes' file `search` tool shells out to `rg`.
# - ffmpeg         : voice/media tooling.
# - curl, ca-certificates : NodeSource setup + healthcheck.
# - procps         : the supervisor uses `pgrep`/process checks.
# - openssh-client : agents may `git`/`ssh` from the terminal tool.
# - iptables       : PR 4 of docs/codex-builder-runtime.md — the codex-builder
#                    profile's egress allowlist (scoped --uid-owner 10001) is
#                    installed at supervisor boot when ENABLE_CODEX_BUILDER=1.
#                    Dormant on every other tenant. Adds ~10 MB to the image.
# - dnsutils       : `dig` resolves OpenAI/GitHub/npm CIDR sets at boot for
#                    the iptables setup. Tiny (~5 MB).
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        git \
        build-essential gcc python3-dev libffi-dev \
        ripgrep \
        ffmpeg \
        curl ca-certificates \
        procps \
        openssh-client \
        iptables \
        dnsutils \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js 22 (NodeSource) --------------------------------------------------
# Required so the Hermes gateway can spawn the 6 stdio MCP servers
# (ctrl-server.mjs + the 5-app bundle) as `node` child processes.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# =============================================================================
# OpenAI Codex CLI — installed for use ONLY by the codex-builder profile.
# =============================================================================
# Available on PATH inside the container, but the codex-builder profile (PR 2)
# is the only one with credentials (CODEX_HOME) and an isolated workspace to
# act on. main/workers/heavy can `which codex` but a `codex exec` would 401
# (no auth file in their CODEX_HOME) and would have no workspace to mutate
# (their terminal.cwd is the profile dir, not /work).
#
# Source: npm @openai/codex. Pin a version arg so a future bump is explicit
# and reviewable. See docs/codex-builder-runtime.md §3 for the install
# rationale (image-size impact, separation of concerns, security model).
#
# PR 1 of 5 — Sir 2026-05-28. The CLI is INERT until PR 2 lands the profile
# config + supervisor entry. No existing profile's behaviour changes here.
ARG CODEX_CLI_REF=0.135.0
RUN npm install -g --no-audit --no-fund "@openai/codex@${CODEX_CLI_REF}" \
 && codex --version

# --- /etc/passwd entry for the codex-builder uid (10001) ----------------------
# Pre-create the uid that PR 2's supervisor.sh will drop the codex-builder
# gateway process onto via `setpriv --reuid 10001`. Without an entry,
# tools that stat the running uid's home dir (codex, ssh, git, npm) emit
# noisy "No passwd entry for user 10001" warnings even though they otherwise
# work — and a future Hermes hook that relies on `pwd.getpwuid(os.geteuid())`
# would crash on KeyError. Doing it in PR 1 keeps PR 2 focused on the profile
# rendering and supervisor wiring; the uid is unused until then.
#
# Home points at the profile state dir (laid down by PR 2's init container).
# Shell is /usr/sbin/nologin — the operator-facing surface for this uid is
# `docker exec -u 10001 ... bash`, NOT an interactive login.
RUN echo 'codex-builder:x:10001:10001::/hermes-state/profiles/codex-builder:/usr/sbin/nologin' \
    >> /etc/passwd \
 && echo 'codex-builder:x:10001:' >> /etc/group

# =============================================================================
# Install Hermes Agent from a PINNED upstream ref.
# =============================================================================
# Pinned to the v0.14.0 release tag (v2026.5.16). Hermes exact-pins every
# direct dependency in pyproject.toml (supply-chain hygiene after the Mini
# Shai-Hulud worm), so this install is reproducible without uv.lock.
#
# Extras chosen for a server runtime (NOT `[all]` — `[all]` pulls `[dev]`
# = pytest/ruff/ty, unwanted in production):
#   cron      — scheduled jobs (croniter is core; kept for completeness)
#   cli       — gateway/CLI menu deps
#   mcp       — MCP client (mcp==1.26.0) — REQUIRED for the 6 stdio servers
#   web       — fastapi + uvicorn — REQUIRED, the OpenAI-compatible API server
#   messaging — telegram / discord / slack adapters for the `main` profile's
#               channels
#   google    — Gmail/Calendar/Drive skill deps
#
# When bumping: update HERMES_REF here AND packages/hermes/VERSION, open a PR.
ARG HERMES_REF=v2026.5.16
RUN pip install --no-cache-dir \
        "hermes-agent[cron,cli,mcp,web,messaging,google] @ git+https://github.com/NousResearch/hermes-agent.git@${HERMES_REF}" \
    && hermes --version || true

# =============================================================================
# Patch: teach the Slack adapter (and base SUPPORTED_DOCUMENT_TYPES) about
# HTML attachments. Upstream Hermes drops .html/.htm uploads silently —
# they're not in the whitelist at gateway/platforms/base.py:SUPPORTED_DOCUMENT_TYPES,
# so the Slack adapter's else-branch hits `continue` and the file never
# reaches the agent. Same gap on Telegram & Discord adapters by inheritance.
#
# See patch_upstream_hermes.py for the full rationale; the script is
# idempotent and tripwire'd so a future HERMES_REF bump that moves the
# upstream needle fails the build loudly.
#
# Sir 2026-05-26 — local-only durable fix for an upstream Hermes bug.
COPY packages/hermes/patch_upstream_hermes.py /tmp/patch_upstream_hermes.py
RUN python3 /tmp/patch_upstream_hermes.py \
 && grep -q '"\.html": "text/html"' /usr/local/lib/python3.12/site-packages/gateway/platforms/base.py \
 && grep -q '"\.html", "\.htm"' /usr/local/lib/python3.12/site-packages/gateway/platforms/slack.py \
 && rm /tmp/patch_upstream_hermes.py

# =============================================================================
# Patch: handle response.output=None in the openai SDK's streaming parser.
# 2026-05-27 OpenAI changed Codex's streaming shape — response snapshots
# during response.output_item.added now carry output=None instead of [].
# The SDK's parse_response() crashes with 'NoneType' object is not
# iterable at openai/lib/_parsing/_responses.py:61, taking down every
# Hermes-main turn using openai-codex. One-line fix: `for output in
# (response.output or []):`. See patch_openai_sdk.py for the full
# rationale; the script is idempotent and tripwire'd so a future openai
# SDK bump that moves or fixes this line fails the build loudly.
#
# Sir 2026-05-27 — local-only durable fix for an upstream openai SDK
# bug exposed by an OpenAI backend contract change.
COPY packages/hermes/patch_openai_sdk.py /tmp/patch_openai_sdk.py
RUN python3 /tmp/patch_openai_sdk.py \
 && grep -q 'for output in (response.output or \[\]):' \
        /usr/local/lib/python3.12/site-packages/openai/lib/_parsing/_responses.py \
 && rm /tmp/patch_openai_sdk.py

# =============================================================================
# Patch: profile-dir-aware parent chmod in hermes_cli/auth.py.
#
# Upstream Hermes' _save_auth_store (and the qwen + nous shared-store
# variants) hard-codes `os.chmod(<path>.parent, 0o700)` on every save —
# token refresh, provider login, write-back of cached creds. In
# alfred-black HERMES_HOME points at a *profile* dir
# (e.g. /hermes-state/profiles/codex-builder) whose mode is owned by the
# init container. PR #118 set the codex-builder profile dir to 0o711 so
# the paperclip-hermes adapter (uid 1000) can traverse to .env for the
# gateway's API_SERVER_KEY; an auth-store save then resets it back to
# 0o700 and the next paperclip → :18793 dispatch 401s with
# hermes_auth_failed / invalid_api_key (GH #119). The companion fix —
# HERMES_HOME_MODE=0711 in the codex-builder profile .env — handles the
# `_secure_dir(home)` path that fires at every CLI startup; this patch
# handles the auth-save path that fires at every token write.
#
# See patch_upstream_hermes_auth.py for the full rationale. The patch is
# idempotent + tripwire'd; a future HERMES_REF bump that moves any of
# the three needles fails the build loudly.
#
# Sir 2026-05-30 — durable fix for GH #119.
COPY packages/hermes/patch_upstream_hermes_auth.py /tmp/patch_upstream_hermes_auth.py
RUN python3 /tmp/patch_upstream_hermes_auth.py \
 && grep -q "alfred-black: profile-dir-aware chmod" \
        /usr/local/lib/python3.12/site-packages/hermes_cli/auth.py \
 && grep -q "_alfred_is_profile_dir" \
        /usr/local/lib/python3.12/site-packages/hermes_cli/auth.py \
 && rm /tmp/patch_upstream_hermes_auth.py

# =============================================================================
# Patch: fd-safe atomic write in utils.py (GH #222).
#
# The codex-builder profile's gateway wedges with `[Errno 24] Too many open
# files`, leaving leaked `.channel_directory_*.tmp` descriptors behind. Once
# the soft nofile limit (1024) is exhausted, every socket/sqlite open fails —
# Slack `auth.test` drops, the kanban sqlite store reports "unable to open
# database file", and the gateway cascades into an unhealthy state.
#
# The leaked file name is produced by gateway/channel_directory.py's writer,
# which calls `atomic_json_write(...)` (refreshed every 5 min). But that
# function is leak-safe — the ACTUAL leak is in the shared helper
# utils.py:atomic_json_write (and atomic_yaml_write +
# atomic_roundtrip_yaml_update): `tempfile.mkstemp()` returns a *raw* fd that
# is only adopted by `with os.fdopen(fd, ...) as f:`. If `os.fdopen` itself
# raises (exactly the fd-pressure condition we hit), the raw fd leaks — the
# `except` unlinks the `.tmp` file but never `os.close(fd)`. Each failed write
# burns one more descriptor, accelerating exhaustion. The patch wraps the
# fd-open in a guard that closes the raw fd on failure — a strict improvement
# for every atomic-write consumer (auth.json, config.yaml, sessions.json),
# not just codex-builder.
#
# See patch_upstream_hermes_channeldir.py for the full rationale. The patch is
# idempotent + tripwire'd; a future HERMES_REF bump that rewrites the helper
# fails the build loudly via the grep below.
#
# Sir 2026-06-01 — durable fix for GH #222.
COPY packages/hermes/patch_upstream_hermes_channeldir.py /tmp/patch_upstream_hermes_channeldir.py
RUN python3 /tmp/patch_upstream_hermes_channeldir.py \
 && grep -q "alfred-black: fd-safe atomic write" \
        /usr/local/lib/python3.12/site-packages/utils.py \
 && grep -q "_alfred_fdopen_or_close" \
        /usr/local/lib/python3.12/site-packages/utils.py \
 && rm /tmp/patch_upstream_hermes_channeldir.py

# =============================================================================
# Bake the hermes-lcm plugin (lossless cross-session context engine).
# =============================================================================
# The `stephenschoettler/hermes-lcm` plugin enables Hermes' LCM context engine
# for the user-facing main profile (lossless reload of prior session context,
# vs the default summariser). Pinned to upstream tag v0.11.1 — never `main` /
# no pin, so the build is reproducible and a supply-chain hijack of the
# upstream branch cannot land silently. The plugin lives at /opt/hermes-lcm
# in the image; supervisor.sh copies it into
# $HERMES_HOME/profiles/main/plugins/hermes-lcm at first boot (main only).
ARG HERMES_LCM_REF=2d108b759e33b72427350dffcb77281f7f61baf9
RUN git clone https://github.com/stephenschoettler/hermes-lcm /opt/hermes-lcm \
    && git -C /opt/hermes-lcm checkout "${HERMES_LCM_REF}" \
    && rm -rf /opt/hermes-lcm/.git

# =============================================================================
# Bake the `one-alfred` plugin (the user-facing continuity layer).
# =============================================================================
# Sir's principle: the user must feel they are talking to ONE Alfred, always.
# Hermes' main/workers/heavy profile split + per-session keying means a
# delegate-completion message lands in a synthetic session that main's actual
# Telegram session has no memory of. The one-alfred plugin closes that gap by
# (a) injecting ctrl-api's alfred_journal into main's inbound context via
# pre_gateway_dispatch, and (b) journalling Sir's replies + main's responses
# via pre_llm_call + post_llm_call. See packages/ctrl/docs/design/one-alfred.md.
#
# Lives at /opt/one-alfred in the image; supervisor.sh deploys it into
# $HERMES_HOME/profiles/main/plugins/one-alfred at first boot (main only —
# workers/heavy never speak to Sir directly so they don't need the bridge).
COPY packages/hermes/plugins/one-alfred /opt/one-alfred

# =============================================================================
# Bake @paperclipai/mcp-server (Paperclip's first-party MCP server).
# =============================================================================
# 48 first-party Paperclip tools (companies, employees, issues, projects,
# routines, approvals, …) wired through Paperclip's REST API. Published by
# paperclipai to npm; we pin a version-tagged release for reproducibility.
#
# This is a DELIBERATE divergence from the five-app stdio bundle convention
# (alfred/sure/plane/vaultwarden/execute live in packages/mcp-server). For
# Paperclip we use the upstream package directly because reimplementing 48
# tools is duplicative + every Paperclip release would mean re-curating the
# wrapper. Trade-off: voice-bridge won't have Paperclip tools yet (it
# connects to packages/mcp-server's HTTP surface only); follow-up PR can add
# a curated wrapper there if voice use-cases emerge. See plan: Paperclip P1,
# Sir 2026-05-26.
#
# Hermes loads this via the `paperclip` block in hermes-config.yaml.njk's
# mcp_servers list; PAPERCLIP_API_KEY (issued by Paperclip's better-auth UI
# — NOT auto-generated, see scripts/bootstrap.sh) and PAPERCLIP_API_URL are
# injected via env.
ARG PAPERCLIP_MCP_REF=2026.525.0
RUN mkdir -p /opt/paperclip-mcp \
 && npm install --prefix /opt/paperclip-mcp --no-audit --no-fund \
        "@paperclipai/mcp-server@${PAPERCLIP_MCP_REF}" \
 && test -f /opt/paperclip-mcp/node_modules/@paperclipai/mcp-server/dist/stdio.js

# =============================================================================
# Bake the MCP bundle.
# =============================================================================
# The 5-app stdio bundle + its node_modules, plus the ctrl-server.mjs HTTP
# proxy. Staged at /opt/mcp-stdio and /opt/mcp; the init container copies
# (rsyncs) these into each Hermes profile dir at first boot so they live on
# the persistent volume and can be hot-updated.
COPY --from=mcp-builder /mcp-server/dist          /opt/mcp-stdio/dist
COPY --from=mcp-builder /mcp-server/node_modules  /opt/mcp-stdio/node_modules
COPY packages/mcp-server/skills                   /opt/mcp-stdio/skills
COPY packages/mcp-server/package.json             /opt/mcp-stdio/package.json
COPY packages/hermes/mcp/ctrl-server.mjs          /opt/mcp/ctrl-server.mjs

# =============================================================================
# Bake skills + agent docs.
# =============================================================================
# - workspace-template/skills : platform-native Alfred skills (teach the
#   user-facing agent how to use its ctrl_* / MCP tools).
# - workspace-template/docs/TOOLS.md : the canonical capability reference.
# - AGENTS.md : the canonical executor instructions (same doc claude.ai's
#   Custom Connector loads).
# The init container deploys these into each Hermes profile dir; staging them
# in the image keeps the init container's job a pure copy.
COPY packages/hermes/workspace-template/skills     /opt/hermes-assets/skills
COPY packages/hermes/workspace-template/docs/TOOLS.md /opt/hermes-assets/TOOLS.md
COPY packages/mcp-server/instructions/alfred-custom-instructions.md /opt/hermes-assets/AGENTS.md

# =============================================================================
# Convenience CLI wrappers.
# =============================================================================
# `alfred chat` opens the main (user-facing) profile; `workers-cli` and
# `heavy-cli` cover the background/heavy profiles. Equivalent to
# `hermes -p <profile> "$@"`. These complement the sticky default set by
# supervisor.sh (`hermes profile use main`) so BOTH styles work:
#   - bare `hermes chat`        — sticky default
#   - explicit `alfred chat`    — wrapper
# The workers/heavy wrappers are suffixed `-cli` to avoid any clash with
# present-or-future binaries named plainly `workers` / `heavy`. `alfred` is
# safe — no existing `alfred` binary in the runtime image.
RUN printf '#!/bin/sh\nexec hermes -p main "$@"\n' > /usr/local/bin/alfred && \
    printf '#!/bin/sh\nexec hermes -p workers "$@"\n' > /usr/local/bin/workers-cli && \
    printf '#!/bin/sh\nexec hermes -p heavy "$@"\n' > /usr/local/bin/heavy-cli && \
    chmod +x /usr/local/bin/alfred /usr/local/bin/workers-cli /usr/local/bin/heavy-cli

# =============================================================================
# codex-builder profile helpers (PR 4 of docs/codex-builder-runtime.md).
# =============================================================================
# Two scripts the codex-builder profile needs at runtime:
#
#   setup-egress-jail.sh — iptables OUTPUT chain scoped --uid-owner 10001,
#     allowlists OpenAI/GitHub/npm/PyPI/crates.io, REJECTs everything else.
#     Called by the supervisor at boot when ENABLE_CODEX_BUILDER=1.
#
#   codex-builder-prep-run.sh — invoked by the codex-builder agent at run
#     start. Creates /work/runs/<runId>/repo as a fresh `git clone` and
#     checks out a feature branch. Returns the workspace path on stdout.
#     Defensive on runId/issueId — refuses path traversal, refuses to
#     overwrite an existing run dir (collisions = bug).
#
# Both are baked into /usr/local/bin so they're on the codex-builder
# gateway's PATH and the existing 3 profiles can ignore them.
#
# PR 5 adds codex-builder-run.sh — the wrapper the codex-builder agent
# invokes per-run. Takes (runId, issueId, promptFile), shells out to
# `codex exec`, commits + pushes, writes /work/runs/<runId>/audit.json,
# emits a JSON envelope on stdout.
COPY packages/hermes/docker/setup-egress-jail.sh /usr/local/bin/codex-builder-setup-egress.sh
COPY packages/hermes/docker/codex-builder-prep-run.sh /usr/local/bin/codex-builder-prep-run.sh
COPY packages/hermes/docker/codex-builder-run.sh /usr/local/bin/codex-builder-run.sh
RUN chmod +x /usr/local/bin/codex-builder-setup-egress.sh \
             /usr/local/bin/codex-builder-prep-run.sh \
             /usr/local/bin/codex-builder-run.sh

# codex-builder profile persona — `SOUL.md` Hermes loads per-profile.
# This is the agent identity Sir's Paperclip persona references. The
# init container copies it into the profile dir (PR 5).
COPY packages/hermes/SOUL.codex-builder.md /opt/hermes-assets/SOUL.codex-builder.md

# =============================================================================
# Self-render renderer scripts (#120 Lane IIb).
# =============================================================================
# When ctrl-api registers a new user-facing profile AFTER init has exited,
# the supervisor's SIGUSR1 reconciler needs to render that profile dir
# inline — no operator step, no init re-run. We bake the SAME two renderer
# scripts the init container runs (render_hermes.py + render_mcp_servers.py)
# plus the two .njk templates into the runtime image, so the runtime self-
# render is byte-identical to a boot-time render.
#
# jinja2 + ruamel.yaml are required by render_hermes.py (template render)
# and render_mcp_servers.py (round-trip YAML mutator). pinned to the same
# versions the init image uses for byte-stable output across re-renders.
#
# render_registry.py is NOT baked here — supervisor reads the registry JSON
# ctrl-api already wrote (no state.db mount in the hermes runtime).
RUN pip install --no-cache-dir "jinja2==3.1.6" "ruamel.yaml==0.18.6"
COPY packages/hermes/init/render_hermes.py       /opt/hermes-init/render_hermes.py
COPY packages/hermes/init/render_mcp_servers.py  /opt/hermes-init/render_mcp_servers.py
COPY packages/hermes/hermes-config.yaml.njk      /opt/hermes-init/templates/hermes-config.yaml.njk
COPY packages/hermes/hermes-profile.env.njk      /opt/hermes-init/templates/hermes-profile.env.njk
RUN chmod 0755 /opt/hermes-init/render_hermes.py /opt/hermes-init/render_mcp_servers.py

# =============================================================================
# Supervisor entrypoint.
# =============================================================================
COPY packages/hermes/docker/hermes-maintenance.sh /opt/hermes-supervisor/hermes-maintenance.sh
COPY packages/hermes/docker/supervisor.sh /opt/hermes-supervisor/supervisor.sh
RUN chmod +x /opt/hermes-supervisor/supervisor.sh \
    /opt/hermes-supervisor/hermes-maintenance.sh

# Hermes resolves all profile state under HERMES_HOME. /opt/data is the
# mounted volume (named volume `hermes_data` in docker-compose). Profiles
# live at ${HERMES_HOME}/profiles/{main,workers}/.
ENV HERMES_HOME=/opt/data \
    HERMES_ASSETS_DIR=/opt/hermes-assets \
    HERMES_MCP_STDIO_SRC=/opt/mcp-stdio \
    HERMES_MCP_CTRL_SRC=/opt/mcp/ctrl-server.mjs

# Hermes API server ports — the gateways bind these directly (the shim that
# used to front them was retired in issue #40). This is the contract every
# caller speaks: the Hermes /v1 API on :18789 (main) / :18790 (workers).
EXPOSE 18789 18790

# Healthcheck probes BOTH gateways' /health endpoints — main :18789
# (chat/onboarding) AND workers :18790 (clerk/background). A green healthcheck
# means both real Hermes runtimes are up; a dead workers gateway must keep the
# container UNhealthy so dependents don't start against a dead clerk gateway.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
    CMD curl -fsS http://localhost:18789/health && curl -fsS http://localhost:18790/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/hermes-supervisor/supervisor.sh"]
