# syntax=docker/dockerfile:1
# =============================================================================
# alfred-worker — the Alfred vault daemon (vault-curator / janitor / distiller
# / surveyor).
#
# Python runtime + the `alfred` CLI (alfred-vault, vendored in-repo at
# packages/alfred-vault) + the openclaw-wrapper. The wrapper speaks Hermes
# `POST /v1/runs` over HTTP (Phase 2) — so this image no longer builds or
# bundles OpenClaw at all.
#
# Build context: REPO ROOT. The Dockerfile COPYs the alfred-vault source from
# packages/alfred-vault and the wrapper + entrypoint from packages/hermes.
# No external git fetch — the CLI source lives in this monorepo.
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

# Alfred vault CLI — vendored in-repo at packages/alfred-vault (no external
# fetch). scaffold/ and skills/ ship via the package's _bundled/ data on
# pip install.
WORKDIR /app
COPY packages/alfred-vault/pyproject.toml packages/alfred-vault/README.md /app/
COPY packages/alfred-vault/src /app/src
RUN pip install --no-cache-dir -e ".[all]"

# The Hermes-native gateway wrapper (POST /v1/runs) + the daemon entrypoint.
COPY packages/hermes/openclaw-wrapper /usr/local/bin/openclaw-wrapper
COPY packages/hermes/dockerfiles/alfred-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /usr/local/bin/openclaw-wrapper /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
