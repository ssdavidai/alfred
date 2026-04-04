# Multi-stage build for alfred-openclaw
# Target: ~3-5GB (down from 15GB single-stage)
#
# Stage 1 (builder): full build tools, compile OpenClaw + qmd
# Stage 2 (runtime): node:22-slim, only compiled artifacts + runtime deps
#
# GGUF models are NOT baked into the image — they download on first boot
# and are cached in the mounted /home/node/.cache/qmd volume.

# ============================================================
# Stage 1: Build OpenClaw + qmd
# ============================================================
FROM node:22-bookworm AS builder

# Build tools for native deps (better-sqlite3, node-llama-cpp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    libsqlite3-dev \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install Bun (required by qmd)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install qmd globally via bun
RUN bun install -g https://github.com/tobi/qmd

# Enable pnpm
RUN corepack enable

# Clone OpenClaw at pinned commit
ARG OPENCLAW_SHA=f9b8499bf6472189750b738fe1db0c43e670df10
RUN git init /openclaw-src && \
    git -C /openclaw-src fetch --depth 1 https://github.com/openclaw/openclaw.git ${OPENCLAW_SHA} && \
    git -C /openclaw-src checkout FETCH_HEAD

# Install dependencies and build
WORKDIR /openclaw-src
RUN pnpm install --frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# Copy full app to /app, strip only .git (saves ~200MB)
# OpenClaw needs various runtime files beyond just dist/ — safer to copy everything
RUN cp -a /openclaw-src /app && \
    rm -rf /app/.git /app/.github

# ============================================================
# Stage 2: Runtime
# ============================================================
# Use bookworm (not slim) — OpenClaw gateway needs native libs at runtime
# that are missing from slim (libsqlite3, libstdc++ for node-llama-cpp, etc.)
FROM node:22-bookworm

# Runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy Bun runtime + qmd from builder (needed for memory backend)
COPY --from=builder /root/.bun /opt/bun
RUN chmod -R a+rX /opt/bun && \
    ln -sf /opt/bun/bin/bun /usr/local/bin/bun && \
    rm -f /opt/bun/bin/qmd && \
    printf '#!/bin/sh\nexec /opt/bun/bin/bun /opt/bun/install/global/node_modules/@tobilu/qmd/src/cli/qmd.ts "$@"\n' > /usr/local/bin/qmd && \
    chmod +x /usr/local/bin/qmd

# Copy built OpenClaw (compiled JS + production node_modules only)
COPY --from=builder /app /app
WORKDIR /app

RUN chown -R node:node /app

# Install alfred-vault CLI (agents use `alfred vault` commands)
RUN pip install --no-cache-dir --break-system-packages alfred-vault

# CLI wrapper for interactive shells
RUN printf '#!/bin/sh\nexec node /app/openclaw.mjs "$@"\n' > /usr/local/bin/openclaw && \
    chmod +x /usr/local/bin/openclaw

# Prepare qmd cache directory (models download on first boot, cached in volume)
RUN mkdir -p /home/node/.cache/qmd && \
    chown -R node:node /home/node/.cache

# NOTE: GGUF models are NOT pre-downloaded. They download on first
# gateway boot (~5 min) and are cached at /home/node/.cache/qmd.
# Mount this path as a volume to persist models across container restarts:
#   volumes:
#     - /mnt/encrypted/qmd-cache:/home/node/.cache/qmd

ENV NODE_ENV=production

USER node

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
