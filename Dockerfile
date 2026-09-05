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
# Porta 13000 (não a convencional 3000) — precisa bater com `PORT` no `.env`
# e com o mapeamento de porta do `docker-compose.yml` (ver ADR-014).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:13000/health || exit 1

EXPOSE 13000
CMD ["node", "dist/server.js"]
