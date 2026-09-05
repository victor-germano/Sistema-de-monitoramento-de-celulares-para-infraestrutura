# PROJECT_MEMORY.md — Memória persistente do projeto

> Fonte oficial da verdade deste projeto. Se a conversa for perdida, a sessão terminar, ou
> outra pessoa/IA assumir o desenvolvimento, este arquivo deve ser suficiente para retomar
> sem depender do histórico da conversa. Ler antes de qualquer alteração; atualizar depois de
> qualquer alteração relevante.

## O que é o projeto

Backend interno de gestão de dispositivos móveis corporativos (EMM/MDM) para o **Grupo
Roveri**, construído sobre a **Android Management API (AMAPI)** do Google. Substitui o SaaS
de terceiros atualmente em uso (**Miradore**) e adiciona uma camada de contexto
organizacional que o SaaS não tem: colaborador, filial, centro de custo, patrimônio, linha
telefônica, chamado de helpdesk.

Frota: smartphones Android **100% corporativos** (não-BYOD), distribuídos entre filiais.
Usuário final do painel: time de infraestrutura. Helpdesk consome via API.

**Fora de escopo (não implementar, não deixar stub):** iOS/iPadOS/macOS, Windows/Autopilot,
BYOD/work profile pessoal.

**Só backend.** Nenhum HTML/frontend é escrito aqui — outra equipe constrói a UI a partir da
documentação em `docs/` (entregue completa na Fase 7).

## Requisito invariante do produto

Nenhum app distribuído pelo sistema pode ser desinstalado pelo usuário do device — garantido
por código (`enforceInvariants`, obrigatório antes de todo `policies.patch`), não por
disciplina do admin. Detalhe completo na spec original (seção 3); implementação chega na
Fase 3.

## Decisões técnicas tomadas

Ver [`docs/DECISOES.md`](./docs/DECISOES.md) para os ADRs completos. Resumo:

- **ADR-001:** UUID v7 gerado na aplicação (lib `uuidv7`), não no Postgres — PG 16 não tem
  `uuidv7()` nativo (só a partir da v18).
- **ADR-002:** mappers da AMAPI formatam duração campo a campo, não com um formatador
  genérico — `maximumTimeToLock` (ms, sem sufixo) é diferente de campos `Duration` reais
  (`'86400s'`).
- **ADR-003:** validação de domínio de e-mail no login é abstraída por provedor OIDC (`hd`
  no Google ≠ `tid` no Entra).
- **ADR-004:** papel `AUDITOR` não acessa nenhuma rota `/devices/*`, só `GET /auditoria`
  (confirmado com o Victor em 2026-09-04).
- **ADR-005:** valores de configuração pendentes/placeholder (enterprise AMAPI, Pub/Sub,
  filiais) — ver seção "Pendências" abaixo.
- **ADR-006:** `NODE_ENV` fixado em `production` no serviço `api` do `docker-compose.yml`.

## Estado atual

**Fase 1 — Fundação: concluída.**

O que existe e funciona:

- Estrutura do repositório, TypeScript strict (+ `noUncheckedIndexedAccess`), ESLint 9 (flat
  config, type-checked) + Prettier.
- Fastify 5 com Helmet, CORS (`ALLOWED_ORIGINS`), rate limit global, Swagger/Swagger UI em
  `/docs`, error handler RFC 9457 (`src/shared/problem-details.ts`).
- Logger Pino com redaction de headers de auth/cookie e de campos de domínio sensíveis
  (imei, serial, iccid, numero, token) já configurados por antecipação — nenhum desses
  campos existe em objeto logado ainda, mas o contrato já está escrito.
- `GET /health` checando Postgres e Redis de verdade (não mock) — 200 se ambos up, 503 se
  algum estiver down. AMAPI **não** está no health check ainda (client só existe na Fase 3;
  decisão deliberada de não simular um check que não existe).
- Drizzle configurado (`src/db/client.ts`, `drizzle.config.ts`) apontando para
  `src/db/schema/` — schema ainda vazio (placeholder), tabelas da seção 6 chegam na Fase 2.
- `docker-compose.yml` (Postgres 16 + Redis 7 + API) e `Dockerfile` multi-stage.
- Testes: unitário do schema de env (`test/unit/env.test.ts`) e integração real de `/health`
  com Testcontainers subindo Postgres+Redis de verdade (`test/integration/health.test.ts`).

Ainda não existe (por fase futura): schema/migrations reais, autenticação OIDC/RBAC,
adapter AMAPI, consumer Pub/Sub, comandos, políticas, colaboradores/linhas, alertas,
dashboards, documentação de handoff.

## Pendências conhecidas (bloqueiam fases específicas, não a Fase 1)

| Pendência                                           | Bloqueia                                      | Situação                                                                                          |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Nome real da enterprise AMAPI (`enterprises/LC...`) | Teste E2E real contra a AMAPI (Fase 3+)       | Placeholder no `.env.example`; empresa vai confirmar                                              |
| Nome do tópico/subscription Pub/Sub                 | Handler `ENROLLMENT`/`STATUS_REPORT` (Fase 4) | Arquivado — depende de conversa com equipe de frontend/infra                                      |
| Lista de filiais existentes                         | Seed de dashboards/relatórios (Fase 6)        | Arquivado — mesma conversa acima                                                                  |
| Versão mínima de Android                            | Alerta `SO_OBSOLETO` (Fase 6)                 | Default provisório: SDK 30 (Android 11), em `ANDROID_VERSAO_MINIMA_SDK`                           |
| Lista fechada de operadoras                         | `linhas.operadora`                            | Decisão: campo texto livre, sem enum — "todas as operadoras famosas atualmente, de um modo geral" |

## Problemas conhecidos

Nenhum em aberto. Um problema foi encontrado e corrigido durante a própria validação da
Fase 1 — ver ADR-006 em `docs/DECISOES.md`: `NODE_ENV=development` vazando do `.env` local
para dentro da imagem de produção do container `api`, derrubando o boot por falta do
`pino-pretty` (devDependency, ausente na imagem final). Corrigido fixando
`NODE_ENV: production` no `docker-compose.yml`.

## Próximo passo

Fase 2 — Schema e auth: todas as migrations da seção 6, seeds de dev, fluxo OIDC completo
(Authorization Code + PKCE), JWT + refresh rotativo, RBAC com os 4 papéis, `/auth/*`,
middleware de auditoria. **Aguardando OK do Victor para começar**, conforme a regra de
trabalho por fases.

---

## Solicitações e alterações recentes

### 2026-09-04 — Kickoff e definição de localização do repositório

**Solicitação do usuário:** iniciar o projeto no VS Code; em seguida, especificação completa
do backend de MDM/EMM (documento de ~15 seções) pedindo construção faseada.

**Objetivo identificado:** ter um repositório local, separado de qualquer outro projeto do
Victor, pronto para receber o backend.

**Risco identificado e resolvido:** o ambiente de trabalho estava apontando para o
repositório de outro projeto do Victor (Germano.AI / emissão de NF, pasta
`VYX - Agente Emissao NF`) — domínios de negócio completamente diferentes. Sinalizado antes
de qualquer escrita de arquivo; Victor confirmou usar o repositório GitHub já criado
(`victor-germano/Sistema-de-monitoramento-de-celulares-para-infraestrutura`), separado do VYX.

**Status:** Concluída.

**O que foi realizado:**

- Clonado o repositório (vazio) para
  `C:\Users\vgerm\OneDrive\Documentos\Sistema-de-monitoramento-de-celulares-para-infraestrutura`,
  isolado do repositório do Germano.AI.
- Coletadas as respostas às perguntas da seção 15 da spec (domínio de e-mail, enterprise
  AMAPI, Pub/Sub, filiais, operadoras — ver ADR-005 e tabela de pendências acima).
- Registradas 5 divergências técnicas com a spec original como ADRs (`docs/DECISOES.md`).

**Decisões técnicas tomadas:** ADR-001 a ADR-005 (ver acima).

---

### 2026-09-04 — Fase 1: Fundação

**Solicitação original:** "faça uma estrutura completa de backend para continuação completa
e detalhista do projeto" — interpretada como Fase 1 completa (a regra de trabalho por fases
da própria spec exige parar e aguardar OK antes da Fase 2).

**Status:** Concluída.

**O que foi realizado:**

- Estrutura do repositório, `package.json`, TypeScript strict, ESLint/Prettier.
- Boot do Fastify com Helmet, CORS, rate limit, Swagger/Swagger UI, error handler RFC 9457.
- Logger Pino com redaction pré-configurada.
- `GET /health` com checagem real de Postgres e Redis.
- Drizzle configurado (client + drizzle-kit), schema placeholder.
- `docker-compose.yml` + `Dockerfile` multi-stage.
- Testes unitário (schema de env) e de integração (`/health` com Testcontainers reais).

**Arquivos criados:** todo o esqueleto listado na seção "Estado atual" acima — ver árvore
completa no histórico da conversa ou `git log`/`git show` deste commit inicial.

**Arquivos alterados:** nenhum (primeiro commit do projeto).

**Arquivos removidos:** nenhum.

**Funcionalidades afetadas:** N/A (primeira entrega).

**Decisões técnicas tomadas:** ADR-001, ADR-002 (preparação — código ainda não existe até a
Fase 3, mas a decisão já está registrada para não ser esquecida); ADR-006 (`NODE_ENV` fixo em
`production` no serviço `api` do compose, achado durante a própria validação desta fase).

**Impacto da alteração:** nenhum risco de regressão (projeto novo).

**Validação realizada:** todas executadas de fato, não só assumidas —

- `npm run typecheck` — limpo.
- `npm run lint` — limpo (ESLint 9 flat config, regras type-aware).
- `npm run format:check` — limpo (após um `npm run format` inicial).
- `npm run build` — gera `dist/` sem erro.
- `npm test` — 7/7 testes passando, incluindo integração real com Postgres e Redis via
  Testcontainers (não mockado).
- `docker compose up --build` (stack completa: postgres + redis + api) — `curl /health`
  retornou `200` com `database` e `redis` "up"; `curl /docs/json` (Swagger) retornou `200`.
- Ambiente de validação limpo depois: containers derrubados, `.env` local e
  `docker-compose.override.yml` (usado só pra desviar de uma porta 5432/6379 já ocupada por
  outro projeto Docker nesta máquina) removidos — nada disso fica no repositório.

**Problemas encontrados:** um, corrigido antes de finalizar a fase — ver ADR-006. Sem esse
teste real via `docker compose up --build`, o bug (imagem de produção crashando no boot por
`NODE_ENV` de dev vazando do `.env`) só apareceria em produção.

**Pendências futuras:** ver tabela "Pendências conhecidas" acima + todo o backlog das
Fases 2 a 7 da spec original.
