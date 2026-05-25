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
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        git \
        build-essential gcc python3-dev libffi-dev \
        ripgrep \
        ffmpeg \
        curl ca-certificates \
        procps \
        openssh-client \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js 22 (NodeSource) --------------------------------------------------
# Required so the Hermes gateway can spawn the 6 stdio MCP servers
# (ctrl-server.mjs + the 5-app bundle) as `node` child processes.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

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
# Supervisor entrypoint.
# =============================================================================
COPY packages/hermes/docker/supervisor.sh /opt/hermes-supervisor/supervisor.sh
RUN chmod +x /opt/hermes-supervisor/supervisor.sh

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
