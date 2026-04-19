FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit-optional
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit-dev --omit-optional && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 9000 9001
CMD ["node", "dist/server.js"]
