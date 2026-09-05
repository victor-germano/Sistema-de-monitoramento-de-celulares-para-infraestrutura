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
- **ADR-007:** enum de banco só pra categorias que o nosso sistema origina; texto livre pra
  valores observados de sistemas externos (AMAPI/Pub/Sub).
- **ADR-008:** append-only de `auditoria` é garantido por **trigger**, não pelo `REVOKE` da
  seção 6 — testado contra Postgres real, o `REVOKE` sozinho não bloqueia o dono da tabela.
- **ADR-009:** imports relativos usam extensão `.ts` (não `.js`) em todo o projeto —
  necessário pra `drizzle-kit` conseguir carregar os arquivos de schema sob `moduleResolution: NodeNext`.
- **ADR-010:** contrato de `/auth/callback` — state stateless (JWT curto), refresh token em
  cookie httpOnly, nunca access token na URL do redirect.
- **ADR-011:** `GET /usuarios` e `PATCH /usuarios/:id` adicionados (gap da seção 10 — sem
  eles a exigência de "elevação de role manual por um ADMIN" da seção 5 seria inatingível).
- **ADR-012:** bootstrap do primeiro ADMIN via `BOOTSTRAP_ADMIN_EMAILS`.
- **ADR-013:** proteção contra remover o último ADMIN + revogação em cascata no reuso de
  refresh token — as duas pendências abaixo, resolvidas.
- **ADR-014:** porta padrão de desenvolvimento é `13000`, não `3000` (conflito local).

## Estado atual

**Fase 2 — Schema e Auth: concluída.**

O que existe e funciona (além de tudo da Fase 1 — ver entrada correspondente abaixo):

- **Schema completo da seção 6** (13 tabelas, `src/db/schema/`) + migrations aplicadas
  (`drizzle/migrations/0000_schema_inicial.sql`, `0001_revoke_auditoria_privileges.sql` — o
  segundo com o trigger de append-only da `auditoria`, ADR-008). UUID v7 gerado em app
  (ADR-001); enum de banco só pra categorias que o sistema origina (ADR-007).
- **Login OIDC completo** (`GET /auth/login`, `GET /auth/callback`) — Authorization Code +
  PKCE, state stateless via JWT curto (`src/domain/auth/oidc-state.ts`), validação de domínio
  por provedor (`src/integrations/oidc/domain-validator.ts`, ADR-003), provisionamento JIT
  com bootstrap de admin (`src/domain/usuarios/repositorio.ts`, ADR-012).
- **Sessão:** JWT interno de 15 min (`src/domain/auth/session-tokens.ts`) + refresh token
  opaco rotativo de 8h em cookie httpOnly (`src/domain/auth/refresh-tokens.ts`,
  `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`). Contrato completo em ADR-010.
- **RBAC:** `src/plugins/rbac.ts` (`withRole(...)`, registry de rotas pra garantir que
  nenhuma fica sem declarar acesso — 100% de cobertura, meta da seção 14) +
  `src/plugins/auth.ts` (decora `request.user` a partir do Bearer token).
- **Gestão de usuário/role:** `GET /usuarios`, `PATCH /usuarios/:id` (ADR-011, gap da spec).
- **Auditoria:** `src/domain/auditoria/registrar.ts`, usado em todo login/logout/rotação de
  role — sempre na mesma transação da ação quando a ação é transacional.
- 67 testes (unitários + integração com Testcontainers reais), cobertura 92,9%
  statements/lines, 100% em `src/plugins/rbac.ts` (meta da seção 14 cumprida).

Ainda não existe (por fase futura): adapter AMAPI, `enforceInvariants`, consumer Pub/Sub,
comandos, políticas (CRUD), colaboradores/linhas (CRUD), alertas, dashboards, documentação
de handoff.

## Pendências conhecidas (bloqueiam fases específicas, não a Fase 2)

| Pendência                                           | Bloqueia                                      | Situação                                                                                          |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Nome real da enterprise AMAPI (`enterprises/LC...`) | Teste E2E real contra a AMAPI (Fase 3+)       | Placeholder no `.env.example`; empresa vai confirmar                                              |
| Nome do tópico/subscription Pub/Sub                 | Handler `ENROLLMENT`/`STATUS_REPORT` (Fase 4) | Arquivado — depende de conversa com equipe de frontend/infra                                      |
| Lista de filiais existentes                         | Seed de dashboards/relatórios (Fase 6)        | Arquivado — mesma conversa acima                                                                  |
| Versão mínima de Android                            | Alerta `SO_OBSOLETO` (Fase 6)                 | Default provisório: SDK 30 (Android 11), em `ANDROID_VERSAO_MINIMA_SDK`                           |
| Lista fechada de operadoras                         | `linhas.operadora`                            | Decisão: campo texto livre, sem enum — "todas as operadoras famosas atualmente, de um modo geral" |

~~Proteção contra remover o último `ADMIN`~~ e ~~revogação em cascata no reuso de refresh
token~~ — **resolvidas** (ADR-013), a pedido do Victor logo após a Fase 2.

## Problemas conhecidos

Nenhum em aberto. Um problema foi encontrado e corrigido durante a validação da Fase 2 — ver
ADR-008: a abordagem literal da spec (`REVOKE UPDATE, DELETE` pro usuário da aplicação) não
bloqueia nada quando essa role também é dona da tabela (é o caso deste projeto — uma única
`DATABASE_URL` pra tudo). Substituído/reforçado por um trigger, testado contra Postgres real.

## Próximo passo

Fase 3 — Adapter AMAPI + invariantes: módulos de `src/integrations/amapi/`,
`enforceInvariants` com testes exaustivos (100% de cobertura, meta da seção 14), retry com
backoff exponencial, fila BullMQ serializada de escrita de política, seed das duas políticas
padrão (`administrativo`, `operacao-campo`). **Aguardando OK do Victor para começar.**

Antes de começar a Fase 3, vale confirmar com o Victor: nome real da `AMAPI_ENTERPRISE_NAME`
(hoje placeholder — ver ADR-005), já que sem ele o teste E2E real da Fase 3 fica bloqueado
(fixtures/mocks cobrem o resto).

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

---

### 2026-09-05 — Fase 2: Schema e Auth

**Solicitação original:** "inicie a fase 2. O projeto está ok até então."

**Status:** Concluída.

**O que foi realizado:**

- Schema completo da seção 6 (13 tabelas) + migrations aplicadas e validadas contra Postgres
  real (incluindo o trigger de append-only da `auditoria`).
- Fluxo OIDC completo (login, callback, provisionamento JIT, bootstrap de admin).
- JWT de sessão + refresh token rotativo em cookie httpOnly.
- RBAC (`withRole`, registry de rotas) + plugin de autenticação (`request.user`).
- Endpoints de gestão de usuário/role (gap preenchido, ADR-011).
- Auditoria de login/logout/rotação de role.
- 67 testes (unitário + integração com Testcontainers reais), cobertura 92,9%, 100% em RBAC.

**Arquivos criados:** `src/db/schema/{_shared,usuarios,refresh-tokens,colaboradores,linhas,politicas,dispositivos,comandos,enrollment-tokens,alertas,auditoria,eventos-brutos}.ts`;
`drizzle/migrations/{0000_schema_inicial,0001_revoke_auditoria_privileges}.sql`;
`src/domain/auth/{session-tokens,refresh-tokens,oidc-state,permissions}.ts`;
`src/domain/usuarios/repositorio.ts`; `src/domain/auditoria/registrar.ts`;
`src/integrations/oidc/{client,domain-validator}.ts`; `src/plugins/{auth,rbac}.ts`;
`src/modules/auth/auth.routes.ts`; `test/unit/{rbac,session-tokens,oidc-state,oidc-domain-validator}.test.ts`;
`test/integration/{rbac,refresh-tokens,auth-flow}.test.ts`; `tsconfig.build.json` (ajustado,
não criado nesta fase).

**Arquivos alterados:** `src/config/env.ts` (vars de OIDC/JWT), `src/app.ts` (registro dos
plugins/rotas novos), `src/modules/health/health.routes.ts` (marcada `PUBLICA`),
`src/db/schema/index.ts` (schema real, substituindo o placeholder), `tsconfig.json`
(`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, ADR-009 — e todo import
relativo do projeto migrado de `.js` pra `.ts`), `vitest.config.ts` (threshold 100% em
`rbac.ts`, exclusão de `server.ts` da cobertura), `package.json` (novas dependências:
`openid-client`, `jose`, `@fastify/cookie`, `fastify-plugin`), `.env.example`, `README.md`,
`docs/SETUP.md`.

**Arquivos removidos:** nenhum.

**Funcionalidades afetadas:** toda a Fase 1 continua funcionando sem alteração de
comportamento (`/health` inalterado, exceto agora marcado `PUBLICA` no registry de RBAC).

**Decisões técnicas tomadas:** ADR-007 a ADR-012 (ver "Decisões técnicas tomadas" acima).

**Impacto da alteração:** nenhuma regressão — Fase 1 revalidada (build/lint/typecheck/testes)
depois de cada mudança estrutural (extensões de import, schema do Fastify context config).

**Validação realizada:**

- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run format:check` — limpos.
- `npm test` — 67/67 passando, incluindo:
  - Migrations reais aplicadas contra Postgres 16 via Testcontainers.
  - `REVOKE` da auditoria testado manualmente contra Postgres real via `psql` **antes** de
    escrever o teste automatizado — foi assim que o ADR-008 foi descoberto.
  - RBAC: teste que falha se alguma rota não declarar `roles`/`public`; 403 pra cada papel
    não autorizado nas rotas `ADMIN`; `/auth/me` aceitando todos os 4 papéis.
  - Fluxo de auth completo mockando só a troca de código por token (fronteira de rede real,
    testada manualmente — ver `docs/SETUP.md`, seção "Login corporativo").
  - Rotação de refresh token: reuso de token já rotacionado falha (sinal de token roubado).
- `npm run test:coverage` — 92,9% statements/lines, 95,1% functions, 82,9% branches
  (acima da meta de 80%/75% da seção 14); `src/plugins/rbac.ts` em 100/100/100/100.

**Problemas encontrados:** um, corrigido antes de finalizar a fase — ver ADR-008
(`REVOKE UPDATE, DELETE` não bloqueia o dono da tabela; resolvido com trigger).

**Pendências futuras:** ver tabela "Pendências conhecidas" acima. Antes da Fase 3: confirmar
`AMAPI_ENTERPRISE_NAME` real com o Victor (ADR-005).

---

### 2026-09-05 — Commits separados, correções pontuais e ajuste de porta

**Solicitação do usuário:** "commite separado no git; resolva os problemas técnicos de forma
cirúrgica e prática; ajuste a porta 13000 para o início da sessão e validação do teste;
inicie a fase 3."

**Status:** Concluída (as três primeiras partes; Fase 3 é a entrada seguinte).

**O que foi realizado:**

- Histórico do git reconstruído em dois commits reais e separados: `feat: Fase 1 —
Fundação` e `feat: Fase 2 — Schema e Auth`, cada um com a árvore de arquivos e o conjunto
  de dependências exatos daquele momento (não um squash do estado atual).
- `PATCH /usuarios/:id` agora recusa (422) rebaixar o último `ADMIN` ativo
  (`contarAdminsAtivos()` em `src/domain/usuarios/repositorio.ts`).
- `rotacionarRefreshToken` agora distingue token expirado (401 simples) de token já
  revogado/rotacionado reutilizado (401 + revoga todas as sessões ativas do usuário — sinal
  de token roubado).
- Porta padrão de dev trocada de 3000 pra 13000 (`.env.example`, `docker-compose.yml`,
  `Dockerfile`, `README.md`, `docs/SETUP.md`) — 3000 está ocupada por um processo alheio a
  este projeto na máquina do Victor.

**Arquivos alterados:** `src/domain/usuarios/repositorio.ts`, `src/domain/auth/refresh-tokens.ts`
(exporta `hashToken` como seam de teste), `src/modules/auth/auth.routes.ts`,
`test/integration/rbac.test.ts`, `test/integration/refresh-tokens.test.ts`, `.env.example`,
`docker-compose.yml`, `Dockerfile`, `README.md`, `docs/SETUP.md`, `docs/DECISOES.md`
(ADR-013, ADR-014), este arquivo.

**Decisões técnicas tomadas:** ADR-013, ADR-014.

**Validação realizada:** `npm run typecheck`/`lint`/`build`/`format:check` limpos; suíte de
testes revalidada (67 + novos testes das duas correções, todos passando).

**Problemas encontrados:** nenhum novo — as duas "pendências" resolvidas aqui já estavam
documentadas como tal desde a Fase 2, não foram descobertas agora.

**Pendências futuras:** inalteradas — ver tabela acima.
