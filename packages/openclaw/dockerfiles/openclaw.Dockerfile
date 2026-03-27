FROM node:22-bookworm

# Install SQLite with extension support (required by qmd for BM25 + vec)
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install qmd via npm (not bun — bun's global install cache breaks after copy)
RUN npm install -g https://github.com/tobi/qmd

RUN corepack enable

WORKDIR /app

# Clone OpenClaw (HEAD of default branch)
RUN git clone --depth 1 https://github.com/openclaw/openclaw.git /openclaw-src

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

# Pre-download qmd GGUF models into node user's cache so the first
# embed run doesn't hit HuggingFace cold-start delays.
RUN mkdir -p /home/node/.cache/qmd && \
    chown -R node:node /home/node/.cache && \
    su node -c "qmd status" 2>/dev/null || true

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
