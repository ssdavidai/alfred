FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
# Build stage skips optional deps — bonjour-service is a runtime-only
# dependency and the TS compile doesn't need it (esphome-mdns.ts wraps the
# import in a dynamic `await import()` with a runtime fallback).
RUN npm install --omit-optional
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
# Runtime install INCLUDES optional deps so bonjour-service is available for
# the ESPHome Native API mDNS advertisement (issue #112 PR1). If the package
# install fails on a constrained base image, esphome-mdns.ts logs + degrades
# to "no mDNS, HA discovers by hostname instead".
RUN npm install --omit-dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Ports: 9000 = HTTP+WS (Twilio Media Streams ingress + /health + /metrics),
# 9001 = optional metrics, 6053 = ESPHome Native API for HA Voice (PR1 skeleton).
EXPOSE 9000 9001 6053
CMD ["node", "dist/server.js"]
