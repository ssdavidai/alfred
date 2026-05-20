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
    rsync gettext-base git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /setup

# Clone Alfred at a pinned commit — provides the vault scaffold + the
# vault-worker skills (vault-curator / vault-janitor / vault-distiller).
ARG ALFRED_SHA=e510cbe84217d091811c3e4217ed15a8a72234f2
RUN git init /alfred-src && \
    git -C /alfred-src fetch --depth 1 https://github.com/ssdavidai/alfred.git ${ALFRED_SHA} && \
    git -C /alfred-src checkout FETCH_HEAD
RUN pip install --no-cache-dir --no-deps /alfred-src

# Jinja2 — the init container renders the per-profile Hermes config.yaml +
# .env from the .njk templates. Nunjucks `.njk` syntax ({{ }}, {% if %},
# `| default`) is Jinja2-compatible for the constructs these templates use.
RUN pip install --no-cache-dir "jinja2==3.1.6"

# Build context is the alfred-black monorepo root. All COPY paths below are
# repo-relative.
COPY packages/hermes/init/entrypoint.sh        ./entrypoint.sh
COPY packages/hermes/init/render_hermes.py     ./render_hermes.py
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

RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
