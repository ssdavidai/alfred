# =============================================================================
# alfred-black-paperclip
#
# Local fork of ghcr.io/paperclipai/paperclip that overlays a patched
# `hermes-paperclip-adapter` whose execute() calls hermes:18789/v1/responses
# over HTTP instead of spawning a hermes CLI binary (absent from the
# upstream image). See packages/paperclip/DESIGN.md for the rationale.
#
# Build context:
#   The build expects the repo root as the build context so it can COPY
#   the adapter source from packages/paperclip/adapter/dist/. Build it
#   first (`cd packages/paperclip/adapter && npm ci && npm run build`)
#   or rely on the in-Dockerfile compile step below.
#
# Tripwire:
#   We hard-pin the upstream paperclip image by digest AND assert the
#   shipped adapter version is exactly 0.2.0. If upstream ships 0.2.1
#   (or a different layout), the build fails fast — re-audit the
#   upstream `execute.ts` against our fork BEFORE bumping the pin.
# =============================================================================

ARG PAPERCLIP_BASE=ghcr.io/paperclipai/paperclip@sha256:711d29717855abbd84d0e576a0a07daff8e9007a229fb8220d8203d492e886e4
ARG HERMES_PAPERCLIP_ADAPTER_REF=0.2.0

# ── Stage 1: compile the patched adapter sources to dist/ ────────────────────
# Node 22 alpine is sufficient — tsc 5.7 + Node 20+ types, no native modules.
FROM node:22-alpine AS adapter-build

WORKDIR /build
COPY packages/paperclip/adapter/package.json packages/paperclip/adapter/tsconfig.json ./
RUN npm install --no-audit --no-fund --silent
COPY packages/paperclip/adapter/src ./src
RUN npm run build && ls -la dist/server dist/shared dist/types

# ── Stage 2: overlay onto the upstream paperclip image ───────────────────────
FROM ${PAPERCLIP_BASE} AS final
ARG HERMES_PAPERCLIP_ADAPTER_REF

# Drift detection — the upstream pnpm-store path includes the version
# number. We refuse to build if the pinned base image ships something
# other than the v0.2.0 layout this fork was audited against.
USER root
RUN set -eu; \
    expected="hermes-paperclip-adapter@${HERMES_PAPERCLIP_ADAPTER_REF}"; \
    if [ ! -d "/app/node_modules/.pnpm/${expected}" ]; then \
        echo "FAIL: upstream paperclip image does not ship ${expected}"; \
        echo "Available hermes-paperclip-adapter versions:"; \
        ls /app/node_modules/.pnpm/ | grep hermes-paperclip || echo "  (none)"; \
        echo ""; \
        echo "Re-audit packages/paperclip/adapter/src against the new upstream"; \
        echo "source BEFORE bumping HERMES_PAPERCLIP_ADAPTER_REF or PAPERCLIP_BASE."; \
        exit 1; \
    fi

# Replace upstream's compiled dist/ with our patched build. We keep the
# upstream package.json + LICENSE intact so pnpm + the Paperclip
# registry continue to resolve the package by name.
COPY --from=adapter-build /build/dist /app/node_modules/.pnpm/hermes-paperclip-adapter@0.2.0/node_modules/hermes-paperclip-adapter/dist

# Smoke-import: load the patched server module under Node to catch
# top-level syntax / resolution errors at build time rather than at the
# first heartbeat. Resolution must run from /app/server because that is
# where pnpm symlinks the package (`/app/server/node_modules/
# hermes-paperclip-adapter -> .pnpm/.../hermes-paperclip-adapter`).
RUN cd /app/server && node --input-type=module -e " \
    import('hermes-paperclip-adapter/server').then((m) => { \
      const required = ['execute', 'testEnvironment', 'sessionCodec', 'listSkills', 'syncSkills', 'detectModel']; \
      for (const k of required) { \
        if (typeof m[k] === 'undefined') { \
          console.error('missing export:', k); process.exit(1); \
        } \
      } \
      console.log('overlay: ok, exports =', Object.keys(m).sort().join(',')); \
    }).catch((e) => { console.error(e); process.exit(1); });"

# Restore upstream's default user (root) + workdir. Upstream paperclip
# image runs as root by default (`docker image inspect …` shows
# `Config.User=""`), even though it defines a `node` uid-1000 user for
# the bootstrap CLI subcommands. Re-asserting root keeps the runtime
# identity consistent across rebuilds.
USER root
WORKDIR /app

# All other directives (CMD, ENTRYPOINT, healthcheck, port, env vars)
# are inherited from the upstream base. Do NOT override here — the
# patch is intentionally surgical.
