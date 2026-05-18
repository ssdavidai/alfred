# ─────────────────────────────────────────────────────────────────────────
# Stage 1 — build the per-tenant MCP-server stdio bundle.
#
# Same source the HTTP MCP server in alfred-mcp-server is built from
# (packages/mcp-server). The init container ships the COMPILED stdio
# bundle so each tenant's openclaw runtime can spawn the 5 stdio MCP
# servers (alfred, sure, plane, vaultwarden, execute) as child
# processes — same tool catalog claude.ai's Custom Connector sees,
# served over stdio for inner agents instead of HTTP for remote ones.
# See MCP-1..5 commits + packages/mcp-server/src/bin/stdio-app.ts.
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
# ─────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    rsync gettext-base git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /setup

# Clone Alfred at pinned commit
ARG ALFRED_SHA=e510cbe84217d091811c3e4217ed15a8a72234f2
RUN git init /alfred-src && \
    git -C /alfred-src fetch --depth 1 https://github.com/ssdavidai/alfred.git ${ALFRED_SHA} && \
    git -C /alfred-src checkout FETCH_HEAD
RUN pip install --no-cache-dir --no-deps /alfred-src

# Build context is the alfred-platform monorepo root (see
# .github/workflows/build-alfred.yml `context: .`). All COPY paths below
# are repo-relative.
COPY packages/openclaw/init/entrypoint.sh ./entrypoint.sh
COPY packages/openclaw/init/sure-bootstrap.rb ./sure-bootstrap.rb
COPY packages/openclaw/init/sure-mutate-base.rb ./sure-mutate-base.rb
COPY packages/openclaw/init/sure-account-mutate.rb ./sure-account-mutate.rb
COPY packages/openclaw/init/sure-rule-mutate.rb ./sure-rule-mutate.rb
COPY packages/openclaw/init/sure-transfer-mutate.rb ./sure-transfer-mutate.rb
COPY packages/openclaw/init/sure-entry-mutate.rb ./sure-entry-mutate.rb
COPY packages/openclaw/init/sure-category-mutate.rb ./sure-category-mutate.rb
COPY packages/openclaw/init/sure-tag-mutate.rb ./sure-tag-mutate.rb
COPY packages/openclaw/init/sure-merchant-mutate.rb ./sure-merchant-mutate.rb
COPY packages/openclaw/init/sure-holding-mutate.rb ./sure-holding-mutate.rb
COPY packages/openclaw/init/sure-valuation-mutate.rb ./sure-valuation-mutate.rb
COPY packages/openclaw/init/sure-recurring-mutate.rb ./sure-recurring-mutate.rb
COPY packages/openclaw/init/sure-duplicate-mutate.rb ./sure-duplicate-mutate.rb
COPY packages/openclaw/init/sure-share-mutate.rb ./sure-share-mutate.rb
COPY packages/openclaw/init/sure-invitation-mutate.rb ./sure-invitation-mutate.rb
COPY packages/openclaw/init/sure-budget-mutate.rb ./sure-budget-mutate.rb
COPY packages/openclaw/init/sure-export-mutate.rb ./sure-export-mutate.rb
COPY packages/openclaw/init/sure-settings-mutate.rb ./sure-settings-mutate.rb
COPY packages/openclaw/config.yaml.tpl ./config.yaml.tpl
# Platform-native workspace content: skills that teach the main Alfred
# agent how to use its ctrl_* tools, plus the canonical TOOLS.md capability
# reference. These are copied into the tenant's openclaw workspace on every
# init run so the main agent discovers them immediately after provisioning.
# Separate from the vault-worker skills (curator/janitor/distiller) which
# are bundled inside the `alfred` Python package and are for the vault
# worker daemons, not the user-facing agent.
COPY packages/openclaw/workspace-template/ ./workspace-template/
COPY packages/openclaw/mcp/ ./mcp/

# The 5-app stdio MCP bundle (MCP-4). The entrypoint rsyncs this to
# each tenant's openclaw-{,workers-}state/mcp-stdio/ on every init pass.
COPY --from=mcp-builder /mcp-server/dist          ./mcp-stdio/dist
COPY --from=mcp-builder /mcp-server/node_modules  ./mcp-stdio/node_modules
COPY packages/mcp-server/skills                   ./mcp-stdio/skills
COPY packages/mcp-server/package.json             ./mcp-stdio/package.json

# AGENTS.md — the canonical instructions file the executor prompt in
# signal_actions.dispatch_action_to_agent points at. Copied to each
# tenant's openclaw state dir as /home/node/.openclaw/AGENTS.md.
COPY packages/mcp-server/instructions/alfred-custom-instructions.md ./AGENTS.md

RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
