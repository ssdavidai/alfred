# syntax=docker/dockerfile:1
# =============================================================================
# alfred-worker — the Alfred vault daemon (vault-curator / janitor / distiller
# / surveyor).
#
# Python runtime + the `alfred` CLI (alfred-vault, public repo) + the
# openclaw-wrapper. The wrapper speaks Hermes `POST /v1/runs` over HTTP
# (Phase 2) — so this image no longer builds or bundles OpenClaw at all.
#
# Build context: packages/hermes (the Dockerfile COPYs openclaw-wrapper and
# dockerfiles/alfred-entrypoint.sh relative to it).
# =============================================================================
FROM python:3.11-slim-bookworm

# Node.js 22 — a few of the alfred CLI's optional tools shell out to it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential cmake ca-certificates gnupg git && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Alfred vault CLI — pinned commit of the public alfred-vault repo.
WORKDIR /app
ARG ALFRED_SHA=cbedd04b1e988cb22fded1414661ff71e4d13cb2
RUN git init /alfred-src && \
    git -C /alfred-src fetch --depth 1 https://github.com/ssdavidai/alfred.git ${ALFRED_SHA} && \
    git -C /alfred-src checkout FETCH_HEAD
# scaffold/ and skills/ are bundled via _bundled/ by pip install.
RUN cp /alfred-src/pyproject.toml /alfred-src/README.md /app/ && \
    cp -r /alfred-src/src /app/src && \
    rm -rf /alfred-src
RUN pip install --no-cache-dir -e ".[all]"

# The Hermes-native gateway wrapper (POST /v1/runs) + the daemon entrypoint.
COPY openclaw-wrapper /usr/local/bin/openclaw-wrapper
COPY dockerfiles/alfred-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /usr/local/bin/openclaw-wrapper /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
