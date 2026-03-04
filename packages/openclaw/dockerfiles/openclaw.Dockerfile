FROM node:22-bookworm

# Install Bun (required for qmd and build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install SQLite with extension support (required by qmd for BM25 + vec)
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install qmd (hybrid BM25+vector search sidecar for OpenClaw memory)
RUN bun install -g https://github.com/tobi/qmd

RUN corepack enable

WORKDIR /app

# Clone OpenClaw
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

# Make qmd + bun accessible to the node user at runtime.
# /root/ has mode 700 so the node user can't traverse it.
# Copy the entire bun+qmd install to /opt/bun (world-readable).
RUN cp -a /root/.bun /opt/bun && \
    chmod -R a+rX /opt/bun && \
    ln -sf /opt/bun/install/global/node_modules/qmd/qmd /usr/local/bin/qmd && \
    ln -sf /opt/bun/bin/bun /usr/local/bin/bun

# Pre-download qmd GGUF models into node user's cache so the first
# embed run doesn't hit HuggingFace cold-start delays.
RUN mkdir -p /home/node/.cache/qmd && \
    chown -R node:node /home/node/.cache && \
    su node -c "qmd status" 2>/dev/null || true

USER node

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
