# Stage 1: Build OpenClaw (for the CLI)
FROM node:22-bookworm AS openclaw-builder

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
RUN corepack enable

WORKDIR /openclaw
RUN git clone --depth 1 https://github.com/openclaw/openclaw.git .
RUN pnpm install --frozen-lockfile && pnpm build

# Stage 2: Alfred runtime (Python + Node.js for openclaw CLI)
FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential cmake ca-certificates gnupg git && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Copy built OpenClaw
COPY --from=openclaw-builder /openclaw/dist /openclaw/dist
COPY --from=openclaw-builder /openclaw/node_modules /openclaw/node_modules
COPY --from=openclaw-builder /openclaw/package.json /openclaw/
RUN printf '#!/bin/sh\nexec node /openclaw/dist/index.js "$@"\n' > /usr/local/bin/openclaw && \
    chmod +x /usr/local/bin/openclaw

# Clone Alfred and install
WORKDIR /app
RUN git clone --depth 1 https://github.com/ssdavidai/alfred.git /alfred-src

# Apply surveyor OpenAI-compat patch
COPY patches/surveyor-openai-compat.patch /tmp/surveyor-openai-compat.patch
RUN cd /alfred-src && git apply /tmp/surveyor-openai-compat.patch || true

# Install Alfred from source
RUN cp /alfred-src/pyproject.toml /alfred-src/README.md /app/ && \
    cp -r /alfred-src/src /app/src && \
    cp -r /alfred-src/skills /app/skills && \
    cp -r /alfred-src/scaffold /app/scaffold && \
    rm -rf /alfred-src
RUN pip install --no-cache-dir -e ".[all]"

COPY openclaw-wrapper /usr/local/bin/openclaw-wrapper
COPY dockerfiles/alfred-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /usr/local/bin/openclaw-wrapper /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
