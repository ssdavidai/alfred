# alfred-setup — the interactive onboarding wizard.
#
# Not a docker-compose service. Run via ./scripts/setup.sh, which bind-mounts
# the host repo at /work so the wizard can read/write /work/.env.
#
#   docker run --rm -it -v "$(pwd)":/work ssdavidai00/alfred-setup:latest
#
# Plain ESM JavaScript, Node 22, no bundler — `node /app/src/wizard.mjs`.
FROM node:22-slim

# App code lives under /app; /work is the bind-mounted host repo.
WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# The wizard reads/writes /work/.env (the host repo dir, bind-mounted here).
WORKDIR /work

ENTRYPOINT ["node", "/app/src/wizard.mjs"]
