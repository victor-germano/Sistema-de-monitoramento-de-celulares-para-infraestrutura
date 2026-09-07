# Sistema de Monitoramento de Celulares

Backend interno de gestão de dispositivos móveis corporativos (EMM/MDM) sobre a
**Android Management API**, com a camada de contexto organizacional (colaborador, filial,
centro de custo, patrimônio, linha telefônica) que o SaaS de terceiros (Miradore) não tem.

Este repositório é **só backend**. A interface é construída por outra equipe a partir da
documentação gerada em [`docs/`](./docs) (destaque para `docs/HANDOFF-FRONTEND.md` e
`docs/openapi.json`, entregues na Fase 7).

> Estado atual: **Fase 5 — Políticas, comandos e cadastros** concluída. Ver `PROJECT_MEMORY.md` para o
> histórico completo de decisões e o que falta.

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
curl http://localhost:13000/health
```

Pra rodar migrations e aplicar o schema (Fase 2):

```bash
npm run db:migrate
```

## Autenticação

Login é sempre via OIDC do provedor corporativo (seção 5 da spec) — não existe usuário/senha
local. Ver `docs/SETUP.md` para configurar `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` num projeto
OAuth de teste e `BOOTSTRAP_ADMIN_EMAILS` pra sair de `VIEWER` no primeiro login. Contrato
completo do fluxo (cookie de refresh, redirect de erro, etc.) em `docs/DECISOES.md` (ADR-010).

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

| Comando                       | O que faz                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run dev`                 | API em watch mode (tsx)                                                                              |
| `npm run worker:pubsub`       | Consumer Pub/Sub em watch mode (Fase 4)                                                              |
| `npm run worker:policy-write` | Worker da fila de escrita de política (Fase 5) — necessário pra `POST`/`PATCH /policies` funcionarem |
| `npm run build`               | Compila para `dist/`                                                                                 |
| `npm run typecheck`           | `tsc --noEmit`, inclui `test/`                                                                       |
| `npm run lint` / `lint:fix`   | ESLint                                                                                               |
| `npm run format`              | Prettier                                                                                             |
| `npm run db:generate`         | Gera migration a partir do schema Drizzle                                                            |
| `npm run db:migrate`          | Aplica migrations pendentes                                                                          |
| `npm run db:studio`           | UI do Drizzle Studio                                                                                 |
| `npm run db:seed`             | Semeia as políticas padrão (idempotente)                                                             |

## Documentação

- [`docs/DECISOES.md`](./docs/DECISOES.md) — ADRs de decisões técnicas tomadas fora da spec original.
- [`docs/SETUP.md`](./docs/SETUP.md) — como reproduzir o ambiente do zero (GCP, env vars, primeiro enrollment).
- [`docs/api/`](./docs/api/) — um markdown por tópico de API (pipeline Pub/Sub, `/devices`, `/internal`,
  `/auditoria`, `/policies`, comandos, `/colaboradores`/`/linhas`), pensado pra quem vai construir a
  interface sem ler o código.
- `PROJECT_MEMORY.md` (raiz) — memória viva do projeto: estado atual, pendências, histórico de solicitações.

Os demais documentos (`ARQUITETURA.md`, `OPERACAO.md`, `LGPD.md`, `HANDOFF-FRONTEND.md`,
`APRESENTACAO-GERENCIA.md`, `openapi.json`) são entregáveis da Fase 7 e ainda não existem.
