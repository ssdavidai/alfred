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

COPY init/entrypoint.sh ./entrypoint.sh
COPY init/sure-bootstrap.rb ./sure-bootstrap.rb
COPY init/sure-mutate-base.rb ./sure-mutate-base.rb
COPY init/sure-account-mutate.rb ./sure-account-mutate.rb
COPY init/sure-rule-mutate.rb ./sure-rule-mutate.rb
COPY init/sure-transfer-mutate.rb ./sure-transfer-mutate.rb
COPY init/sure-entry-mutate.rb ./sure-entry-mutate.rb
COPY init/sure-category-mutate.rb ./sure-category-mutate.rb
COPY init/sure-tag-mutate.rb ./sure-tag-mutate.rb
COPY init/sure-merchant-mutate.rb ./sure-merchant-mutate.rb
COPY init/sure-holding-mutate.rb ./sure-holding-mutate.rb
COPY init/sure-valuation-mutate.rb ./sure-valuation-mutate.rb
COPY config.yaml.tpl ./config.yaml.tpl
# Platform-native workspace content: skills that teach the main Alfred
# agent how to use its ctrl_* tools, plus the canonical TOOLS.md capability
# reference. These are copied into the tenant's openclaw workspace on every
# init run so the main agent discovers them immediately after provisioning.
# Separate from the vault-worker skills (curator/janitor/distiller) which
# are bundled inside the `alfred` Python package and are for the vault
# worker daemons, not the user-facing agent.
COPY workspace-template/ ./workspace-template/
COPY mcp/ ./mcp/

RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
