# vault-init — one-shot that pulls every tenant secret out of the local
# Vaultwarden and rewrites /opt/alfred/compose/.env. Runs after vaultwarden
# is healthy on every `docker compose up`. The fetch script (vault-init.sh)
# ships in PR2 of the Vaultwarden rollout; this Dockerfile is the runtime
# scaffolding so PR1 produces a buildable image to wire into the compose
# template.
#
# Alpine + node + the Bitwarden CLI. Image stays small (~80MB) since bw
# CLI is the only meaningful dep. jq + curl + bash are available because
# vault-init.sh will use them (PR2 wires them in).
FROM node:22-alpine
RUN apk add --no-cache bash jq curl ca-certificates \
    && npm install --global --omit=dev @bitwarden/cli@2024.10.0 \
    && npm cache clean --force
WORKDIR /work
# Default CMD is a no-op so PR1's compose can `up` the service safely.
# vault-init.sh replaces this in PR2.
CMD ["bash", "-c", "echo 'vault-init no-op; awaiting PR2 fetch script' && exit 0"]
