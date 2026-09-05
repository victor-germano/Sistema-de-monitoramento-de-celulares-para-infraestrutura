# Build multi-stage: a imagem final não carrega devDependencies nem código-fonte
# TypeScript, só o JS compilado + node_modules de produção.
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# curl não vem no alpine por padrão; wget vem no busybox e já basta pro
# healthcheck do compose/orquestrador não depender de mais uma lib na imagem.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

EXPOSE 3000
CMD ["node", "dist/server.js"]
