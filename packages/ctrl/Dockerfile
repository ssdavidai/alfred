# syntax=docker/dockerfile:1
# =============================================================================
# alfred-ctrl-api — the tenant API server for alfred-black.
#
# Builds the standalone API bundle (`dist/api.mjs`) with esbuild and ships it
# on node:22-slim. This image replaces the pre-monorepo host bind-mount of
# `/opt/alfred/api.mjs` — the bundle is now baked in.
#
# Runtime responsibilities that drive the baked-in tooling:
#   * docker CLI + compose plugin — ctrl-api restarts sibling containers
#     (`hermes`, `alfred`, …) via the bind-mounted docker socket.
#   * procps / jq / curl — diagnostics, health probes, log helpers.
#   * python3 + python3-yaml — a handful of routes shell out to `python3 -c`
#     for YAML/JSON config surgery (agents.ts, learning.ts).
#   * sqlite-vec — loadable SQLite extension; ctrl-api opens it at boot so the
#     `embedding` table (alfred-state.db, Store 2) can do vector k-NN. See
#     docs/STORAGE-ARCHITECTURE.md.
#
# Multi-arch: build with `docker buildx build --platform linux/amd64,linux/arm64`.
# =============================================================================

# ---- builder -----------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /build

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build the API bundle.
COPY tsconfig.json build.mjs ./
COPY src ./src
RUN node build.mjs \
  && test -f dist/api.mjs

# ---- sqlite-vec ----------------------------------------------------------------
# sqlite-vec ships prebuilt loadable extensions per platform on its GitHub
# releases. We fetch the correct artefact for the build's target arch and stage
# it at a stable path the runtime loads from.
FROM node:22-slim AS vecfetch
ARG TARGETARCH
ARG SQLITE_VEC_VERSION=v0.1.6
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) VEC_ARCH="x86_64" ;; \
    arm64) VEC_ARCH="aarch64" ;; \
    *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  mkdir -p /sqlite-vec; \
  curl -fsSL \
    "https://github.com/asg017/sqlite-vec/releases/download/${SQLITE_VEC_VERSION}/sqlite-vec-${SQLITE_VEC_VERSION#v}-loadable-linux-${VEC_ARCH}.tar.gz" \
    -o /tmp/vec.tar.gz; \
  tar -xzf /tmp/vec.tar.gz -C /sqlite-vec; \
  # Normalise the extension filename to a predictable path.
  find /sqlite-vec -name 'vec0.*' -exec cp {} /sqlite-vec/vec0.so \; ; \
  test -f /sqlite-vec/vec0.so

# ---- runtime -------------------------------------------------------------------
FROM node:22-slim AS runtime

# Baked-in tooling. Debian's docker.io provides the `docker` CLI; the Compose
# v2 plugin is NOT packaged for Debian, so fetch the official plugin binary
# into the CLI plugins dir. ctrl-api shells `docker compose` to restart
# sibling containers via the bind-mounted docker socket.
#
# `zstd` (#114 PR 5) — the cold-archive read path uses node:zlib's streaming
# zstd codec (Node >= 22.15), so the runtime does NOT shell out to /usr/bin/zstd
# at request time. We install the CLI anyway so operators can inspect a cold
# blob ad-hoc (`zstd -d /cold-files/<ULID>.zst -o /tmp/probe`) without having to
# write a Node one-liner. ~150 KB image cost; worth it for the on-call ergonomics.
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       procps \
       jq \
       curl \
       ca-certificates \
       python3 \
       python3-yaml \
       openssh-client \
       docker.io \
       zstd \
  && rm -rf /var/lib/apt/lists/* \
  && case "${TARGETARCH}" in \
       amd64) DC_ARCH="x86_64" ;; \
       arm64) DC_ARCH="aarch64" ;; \
       *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
     esac \
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && curl -fsSL \
       "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${DC_ARCH}" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
  && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
  && docker compose version

WORKDIR /app

# The standalone bundle. node:sqlite is built into Node 22 — no node_modules
# needed at runtime (build.mjs marks every node builtin external and bundles
# everything else).
COPY --from=builder /build/dist/api.mjs ./api.mjs

# Aggregate health script (#526). Baked here so GET /api/v1/admin/health reports
# real disk status instead of the permanent "degraded" produced by a missing file.
# The `test -x` is intentional: a missing source file must fail the BUILD, not
# produce a silent runtime degradation (the very failure mode this fixes).
COPY healthcheck.sh /opt/alfred/healthcheck.sh
RUN chmod +x /opt/alfred/healthcheck.sh \
  && test -x /opt/alfred/healthcheck.sh

# sqlite-vec loadable extension. ctrl-api loads it via SQLITE_VEC_PATH at boot.
COPY --from=vecfetch /sqlite-vec/vec0.so /usr/local/lib/sqlite-vec/vec0.so
ENV SQLITE_VEC_PATH=/usr/local/lib/sqlite-vec/vec0.so

# Defaults — overridable from compose `.env`.
ENV AAS_PORT=3100 \
    AAS_HOST=0.0.0.0 \
    COMPOSE_DIR=/srv/alfred-black \
    STATE_DB_PATH=/state/alfred-state.db \
    INGEST_DB_PATH=/ingest/ingest.db \
    COLD_DB_PATH=/cold/cold.db \
    NODE_ENV=production

EXPOSE 3100

# alfred-state.db / ingest.db / cold.db (Store 3 archive) live on named volumes
# mounted at these paths.
#
# /files (Store 5 live) + /cold-files (Store 5 cold, #114 PR 5) are mounted
# from the `files_data` + `files_cold_data` named volumes by docker-compose.
VOLUME ["/state", "/ingest", "/cold", "/files", "/cold-files"]

# Node 22's node:sqlite is behind an experimental flag.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${AAS_PORT}/api/v1/health" || exit 1

ENTRYPOINT ["node", "--experimental-sqlite", "/app/api.mjs"]
