# ─────────────────────────────────────────────────────────────────────────
# Stage 1 — build the per-VM MCP-server stdio bundle.
#
# Same source the HTTP MCP server in packages/mcp-server is built from.
# The init container ships the COMPILED stdio bundle so the Hermes runtime
# can spawn the 5 stdio MCP servers (alfred, sure, plane, vaultwarden,
# execute) as child processes — same tool catalog claude.ai's Custom
# Connector sees, served over stdio for inner agents instead of HTTP.
# See packages/mcp-server/src/bin/stdio-app.ts.
# ─────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS mcp-builder
WORKDIR /mcp-server
COPY packages/mcp-server/package.json packages/mcp-server/package-lock.json* ./
RUN npm ci --prefer-offline --no-audit --no-fund
COPY packages/mcp-server/tsconfig.json ./
COPY packages/mcp-server/src ./src
RUN npm run build
# At this point: /mcp-server/dist/, /mcp-server/node_modules/.

# ─────────────────────────────────────────────────────────────────────────
# Stage 2 — the init container itself.
#
# A one-shot bootstrap container. Idempotent: scaffolds the vault, deploys
# skills + the MCP bundle into the Hermes profile dirs, generates the
# alfred config + gateway token, renders the per-profile Hermes config.yaml
# and .env, and stages the Sure bootstrap inputs. Exits 0.
# ─────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    rsync gettext-base git ca-certificates curl gnupg \
    acl \
    util-linux \
    && rm -rf /var/lib/apt/lists/*
# acl + util-linux: setfacl (codex-builder uid-10001 negative ACL on
# /vault, /alfred-data, other-profile dirs) + setpriv (the negative-
# assert spot-checks in step 7b). PR 4b — without these the existing
# "world readable" perms on /vault (0644) etc. defeat the uid-only
# negative-asserts because uid 10001 reads as "other". ACL deny rules
# preserve every other consumer's read access (alfred-learn uid 1000,
# vault-cli root, hermes main uid 10000) while specifically blocking
# uid 10001. ~2 MB added.

# docker-ce-cli only — bootstrap-paperclip.sh shells out to `docker exec`
# / `docker inspect` against the paperclip sidecar (via the docker socket
# bind-mounted on the paperclip-init compose service). We pull JUST the
# CLI from Docker's apt repo so we don't drag in containerd / runc the
# way Debian's `docker.io` meta-package would. ~30 MB installed.
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /setup

# Alfred vault package — vendored in-repo at packages/alfred-vault (no
# external fetch). Provides the vault scaffold + the vault-worker skills
# (vault-curator / vault-janitor / vault-distiller) via the package's
# _bundled/ data. Installed --no-deps: the init container only needs the
# scaffold + skills + alfred._data, not the daemon's runtime dependencies.
COPY packages/alfred-vault /alfred-src
RUN pip install --no-cache-dir --no-deps /alfred-src

# Jinja2 — renders the per-profile Hermes config.yaml + .env from .njk
# templates (Nunjucks `.njk` is a Jinja2-compatible subset here).
# ruamel.yaml — round-trip YAML editor (preserves comments + quotes +
# ordering) used by the ADD-only config.yaml mutators (render_sms_gateway,
# render_mcp_servers). PyYAML would reformat the operator-owned config on
# every write; ruamel.yaml leaves the surrounding file byte-stable when it
# only needs to graft a new sub-block.
RUN pip install --no-cache-dir "jinja2==3.1.6" "ruamel.yaml==0.18.6"

# Build context is the alfred-black monorepo root. All COPY paths below are
# repo-relative.
COPY packages/hermes/init/entrypoint.sh        ./entrypoint.sh
COPY packages/hermes/init/render_hermes.py     ./render_hermes.py
COPY packages/hermes/init/render_sms_gateway.py ./render_sms_gateway.py
# render_mcp_servers.py — idempotent ADD-only mutator that backfills new
# required MCP server entries (e.g. `hass` PR #128, `files` PR #130) into
# the operator-owned per-profile config.yaml. Sibling of render_sms_gateway.
COPY packages/hermes/init/render_mcp_servers.py ./render_mcp_servers.py
# migrate_main_profile_tool_trim.py — idempotent ADD-only mutator that
# backfills `mcp_servers.{sure,hass,paperclip}.tools.include` on the
# operator-owned main-profile config.yaml. Issue #175 (2026-05-30): voice
# /HA-Assist calendar queries timed out because the main profile was
# inlining 321 MCP tool schemas (~67k input tokens per turn). Workers/
# heavy/codex-builder are unaffected (no-op). Sibling of render_mcp_servers.
COPY packages/hermes/init/migrate_main_profile_tool_trim.py ./migrate_main_profile_tool_trim.py
# Paperclip auto-bootstrap. Invoked as the entrypoint of the sibling
# `paperclip-init` compose service (see docker-compose.yaml). Not run by
# this image's default entrypoint.sh — keeps the main init container
# focused on filesystem scaffolding (no docker.sock there).
COPY packages/hermes/init/bootstrap-paperclip.sh ./bootstrap-paperclip.sh
# paperclip_board_key.py — board API key minting + per-profile .env writer.
# Imported by bootstrap-paperclip.sh's Python redeem block (step 12) and
# usable as a standalone CLI (PAPERCLIP_BOARD_API_TOKEN env → writes to
# HERMES_STATE_DIR/profiles/*/.env). Lib AND script.
COPY packages/hermes/init/paperclip_board_key.py ./paperclip_board_key.py
COPY packages/hermes/init/sure-bootstrap.rb    ./sure-bootstrap.rb
COPY packages/hermes/init/sure-mutate-base.rb  ./sure-mutate-base.rb
COPY packages/hermes/init/sure-account-mutate.rb    ./sure-account-mutate.rb
COPY packages/hermes/init/sure-rule-mutate.rb       ./sure-rule-mutate.rb
COPY packages/hermes/init/sure-transfer-mutate.rb   ./sure-transfer-mutate.rb
COPY packages/hermes/init/sure-entry-mutate.rb      ./sure-entry-mutate.rb
COPY packages/hermes/init/sure-category-mutate.rb   ./sure-category-mutate.rb
COPY packages/hermes/init/sure-tag-mutate.rb        ./sure-tag-mutate.rb
COPY packages/hermes/init/sure-merchant-mutate.rb   ./sure-merchant-mutate.rb
COPY packages/hermes/init/sure-holding-mutate.rb    ./sure-holding-mutate.rb
COPY packages/hermes/init/sure-valuation-mutate.rb  ./sure-valuation-mutate.rb
COPY packages/hermes/init/sure-recurring-mutate.rb  ./sure-recurring-mutate.rb
COPY packages/hermes/init/sure-duplicate-mutate.rb  ./sure-duplicate-mutate.rb
COPY packages/hermes/init/sure-share-mutate.rb      ./sure-share-mutate.rb
COPY packages/hermes/init/sure-invitation-mutate.rb ./sure-invitation-mutate.rb
COPY packages/hermes/init/sure-budget-mutate.rb     ./sure-budget-mutate.rb
COPY packages/hermes/init/sure-export-mutate.rb     ./sure-export-mutate.rb
COPY packages/hermes/init/sure-settings-mutate.rb   ./sure-settings-mutate.rb

# Plane first-boot admin auto-seed — staged into /alfred-data by entrypoint.sh
# step 11, executed by the separate `plane-init` compose service which
# runs it under `python manage.py shell` inside makeplane/plane-backend.
COPY packages/hermes/init/plane-bootstrap.py        ./plane-bootstrap.py

# Alfred vault-daemon config template (the `alfred` Python package's config).
COPY packages/hermes/config.yaml.tpl ./config.yaml.tpl

# The per-profile Hermes config.yaml + .env templates (rendered by
# render_hermes.py — see entrypoint step "Render Hermes profiles").
COPY packages/hermes/hermes-config.yaml.njk  ./hermes-config.yaml.njk
COPY packages/hermes/hermes-profile.env.njk  ./hermes-profile.env.njk

# Platform-native workspace content: skills that teach the user-facing
# Alfred how to use its MCP tools, plus the canonical TOOLS.md capability
# reference. Deployed into each Hermes profile dir on every init run.
COPY packages/hermes/workspace-template/ ./workspace-template/
COPY packages/hermes/mcp/                ./mcp/

# The 5-app stdio MCP bundle. The entrypoint rsyncs this into each Hermes
# profile's mcp-stdio/ directory on every init pass.
COPY --from=mcp-builder /mcp-server/dist          ./mcp-stdio/dist
COPY --from=mcp-builder /mcp-server/node_modules  ./mcp-stdio/node_modules
COPY packages/mcp-server/skills                   ./mcp-stdio/skills
COPY packages/mcp-server/package.json             ./mcp-stdio/package.json

# AGENTS.md — the canonical executor instructions. Deployed into each
# Hermes profile dir as AGENTS.md.
COPY packages/mcp-server/instructions/alfred-custom-instructions.md ./AGENTS.md

# SOUL.md — Alfred's persona/identity. Deployed into each profile as the
# baseline SOUL, replacing Hermes' stock Nous identity. The onboarding-chosen
# persona at /vault/SOUL.md takes precedence when present (see entrypoint).
COPY packages/hermes/init/SOUL.md ./SOUL.md

# SOUL.codex-builder.md — the codex-builder profile's distinct persona (a
# sealed engineering executor, NOT Alfred). Deployed into the codex-builder
# profile dir by entrypoint.sh step 7b. Not used by main/workers/heavy.
COPY packages/hermes/SOUL.codex-builder.md ./SOUL.codex-builder.md

RUN chmod +x entrypoint.sh bootstrap-paperclip.sh

ENTRYPOINT ["./entrypoint.sh"]
