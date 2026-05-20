# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --prefer-offline --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --prefer-offline --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8787
# node:sqlite needs the experimental flag on Node 22 LTS (Node 22.5+ has it
# enabled by default; 22.4 still needs the flag). Hard-pin the flag for
# reproducibility — costs nothing if it becomes stable.
CMD ["node", "--experimental-sqlite", "dist/index.js"]
