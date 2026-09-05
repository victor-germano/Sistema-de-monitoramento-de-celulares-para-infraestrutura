# Sistema de Monitoramento de Celulares

Backend interno de gestão de dispositivos móveis corporativos (EMM/MDM) sobre a
**Android Management API**, com a camada de contexto organizacional (colaborador, filial,
centro de custo, patrimônio, linha telefônica) que o SaaS de terceiros (Miradore) não tem.

Este repositório é **só backend**. A interface é construída por outra equipe a partir da
documentação gerada em [`docs/`](./docs) (destaque para `docs/HANDOFF-FRONTEND.md` e
`docs/openapi.json`, entregues na Fase 7).

> Estado atual: **Fase 1 — Fundação** concluída. Ver `PROJECT_MEMORY.md` para o histórico
> completo de decisões e o que falta.

## Stack

Node.js 22 · TypeScript strict · Fastify 5 · Zod · Drizzle ORM · PostgreSQL 16 · BullMQ ·
Redis 7 · `googleapis` (AMAPI) · Pino · Vitest + Testcontainers.

## Rodando localmente

Pré-requisitos: Node 22+, Docker Desktop (com Compose v2).

```bash
cp .env.example .env
npm install

# sobe Postgres + Redis (+ a própria API, se quiser rodar tudo em container)
docker compose up -d postgres redis

npm run dev        # API em modo watch, fora de container
curl http://localhost:3000/health
```

Para rodar a stack inteira containerizada (API incluída):

```bash
docker compose up --build
```

## Testes

```bash
npm test            # unitários + integração (sobe Postgres/Redis via Testcontainers — requer Docker)
npm run test:coverage
```

## Scripts úteis

| Comando                     | O que faz                                 |
| --------------------------- | ----------------------------------------- |
| `npm run dev`               | API em watch mode (tsx)                   |
| `npm run build`             | Compila para `dist/`                      |
| `npm run typecheck`         | `tsc --noEmit`, inclui `test/`            |
| `npm run lint` / `lint:fix` | ESLint                                    |
| `npm run format`            | Prettier                                  |
| `npm run db:generate`       | Gera migration a partir do schema Drizzle |
| `npm run db:migrate`        | Aplica migrations pendentes               |
| `npm run db:studio`         | UI do Drizzle Studio                      |

## Documentação

- [`docs/DECISOES.md`](./docs/DECISOES.md) — ADRs de decisões técnicas tomadas fora da spec original.
- [`docs/SETUP.md`](./docs/SETUP.md) — como reproduzir o ambiente do zero (GCP, env vars, primeiro enrollment).
- `PROJECT_MEMORY.md` (raiz) — memória viva do projeto: estado atual, pendências, histórico de solicitações.

Os demais documentos (`ARQUITETURA.md`, `OPERACAO.md`, `LGPD.md`, `HANDOFF-FRONTEND.md`,
`APRESENTACAO-GERENCIA.md`, `openapi.json`) são entregáveis da Fase 7 e ainda não existem.
