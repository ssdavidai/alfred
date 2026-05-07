FROM node:22-bookworm

# Install build tools + SQLite (required by qmd's native deps: better-sqlite3, node-llama-cpp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    libsqlite3-dev \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install Bun (qmd requires bun for installation)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install qmd via bun, then make it accessible to node user
# The bin/qmd is a shell script that dispatches to dist/cli/qmd.js, but bun
# install doesn't run the build step. Use bun to run the TS source directly.
RUN bun install -g https://github.com/tobi/qmd && \
    cp -a /root/.bun /opt/bun && \
    chmod -R a+rX /opt/bun && \
    ln -sf /opt/bun/bin/bun /usr/local/bin/bun && \
    rm -f /opt/bun/bin/qmd /root/.bun/bin/qmd && \
    printf '#!/bin/sh\nexec /opt/bun/bin/bun /opt/bun/install/global/node_modules/@tobilu/qmd/src/cli/qmd.ts "$@"\n' > /usr/local/bin/qmd && \
    chmod +x /usr/local/bin/qmd

RUN corepack enable

WORKDIR /app

# Clone OpenClaw at known-good commit — v2026.5.6 (598 commits since v2026.5.3,
# critical: 92339752ea "fix(net): bound guarded fetch dispatcher cleanup". Pre-v5.6
# closeDispatcher awaited dispatcher.close() unbounded — when a guarded fetch
# timed out, close() could hang indefinitely waiting for sockets to drain. That
# wedge cascaded through model dispatch, gateway WS handlers, and subagent
# announce paths — surfaced on david as "All models failed: This operation was
# aborted", "gateway timeout after 120000ms", and 1006 abnormal WS closures.
# v5.6 caps close() at 100ms then forcibly destroys the dispatcher.
# Also picks up: gateway responsiveness on reset/refresh, orphan terminal
# session prevention, stale session route repair, gateway shutdown error
# visibility, and the file-transfer plugin / fail-closed invalid config
# carried over from v5.3.
ARG OPENCLAW_SHA=c97b9f79ec43b531a3472c3219ca51efbf7695a3
RUN git init /openclaw-src && \
    git -C /openclaw-src fetch --depth 1 https://github.com/openclaw/openclaw.git ${OPENCLAW_SHA} && \
    git -C /openclaw-src checkout FETCH_HEAD

# Install and build
WORKDIR /openclaw-src
RUN pnpm install --frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Copy built app to /app
RUN cp -a /openclaw-src/. /app/ && rm -rf /openclaw-src

WORKDIR /app
RUN chown -R node:node /app

# qmd GGUF models are NOT pre-downloaded. They download on first gateway boot
# (~5 min one-time cost) and are cached at /home/node/.cache/qmd.
# Mount this path as a Docker volume to persist models across container restarts:
#   - /mnt/encrypted/openclaw/qmd-cache:/home/node/.cache/qmd
RUN mkdir -p /home/node/.cache/qmd && \
    chown -R node:node /home/node/.cache

# Install Python + alfred-vault CLI (agents use `alfred vault` commands via sessions_spawn)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && \
    pip install --no-cache-dir --break-system-packages alfred-vault && \
    rm -rf /var/lib/apt/lists/*

# CLI wrappers for interactive shells
RUN printf '#!/bin/sh\nexec node /app/openclaw.mjs "$@"\n' > /usr/local/bin/openclaw && \
    chmod +x /usr/local/bin/openclaw

# Install Claude Code CLI (used for API token setup and agent workflows)
RUN npm install -g @anthropic-ai/claude-code

USER node

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
