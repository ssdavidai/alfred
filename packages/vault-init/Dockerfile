# vault-init — pulls every secret out of the local Vaultwarden and rewrites
# /opt/alfred/compose/.env on every `docker compose up`. Also ships the
# bootstrap-signup + migration scripts so the SAME image can be used as a
# one-shot for the david cutover (and future tenant rollouts) without needing
# a second container.
#
# Bundled scripts (all under /opt/vault-init):
#   vault-init.sh          — runtime fetch+rewrite (default CMD)
#   migrate.sh             — one-shot .env → vaultwarden importer
#   bootstrap-signup.mjs   — Bitwarden client-crypto + /api/accounts/register
#                            so Sir's account is auto-created without browser
#                            interaction (fallback: web-UI signup)
FROM node:22-alpine
RUN apk add --no-cache bash jq curl ca-certificates \
    && npm install --global --omit=dev @bitwarden/cli@2024.10.0 \
    && npm cache clean --force
WORKDIR /opt/vault-init
COPY vault-init.sh /opt/vault-init/vault-init.sh
COPY migrate.sh /opt/vault-init/migrate.sh
COPY import-files.sh /opt/vault-init/import-files.sh
COPY bootstrap-signup.mjs /opt/vault-init/bootstrap-signup.mjs
COPY serve.sh /opt/vault-init/serve.sh
RUN chmod 0755 /opt/vault-init/vault-init.sh /opt/vault-init/migrate.sh \
    && chmod 0755 /opt/vault-init/import-files.sh \
    && chmod 0755 /opt/vault-init/bootstrap-signup.mjs \
    && chmod 0755 /opt/vault-init/serve.sh
CMD ["bash", "/opt/vault-init/vault-init.sh"]
