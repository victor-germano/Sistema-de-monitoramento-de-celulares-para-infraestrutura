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
por código (`enforceInvariants`, `src/domain/policy/policy-invariants.ts`), não por
disciplina do admin. **Implementado na Fase 3, 100% de cobertura de teste.** O mecanismo real
é `uninstallAppsDisabled: true` a nível de política — não o campo por-app `uninstallBlocked`
que a spec original cita, que não existe no schema atual da AMAPI (ver ADR-015).

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
- **ADR-015:** `uninstallBlocked` não existe no schema atual da AMAPI —
  `uninstallAppsDisabled` (nível de política) é o mecanismo real; o campo por-app é mantido
  mesmo assim, defensivamente, por pedido do Victor.
- **ADR-016:** valores em aberto no seed das políticas padrão (`maximumTimeToLock`, lista de
  apps por perfil) — decisões nossas/pendências de negócio, não pedidas pela spec.
- **ADR-017:** formato real da mensagem Pub/Sub — `notificationType` em `message.attributes`
  (não em `data`), `data` é o recurso cru, teste vem como `test`/`TEST`, existe
  `ENTERPRISE_UPGRADE` fora da lista da seção 8.
- **ADR-018:** coluna `dispositivos.ativo` (gap entre seção 6 e seção 10, mesmo padrão do
  ADR-011).
- **ADR-019:** 3 divergências no mapeamento `Device` (AMAPI) → `dispositivos`/
  `dispositivo_apps` — `compliance_state` derivado (não existe na AMAPI), bateria/storage do
  evento mais recente (não campo estático), `installType` de app nunca vem do
  `STATUS_REPORT` (é atributo de política).
- **ADR-020:** alerta aberto único por dispositivo+tipo garantido por índice único parcial
  (`ON CONFLICT DO NOTHING`), não por check-then-insert.
- **ADR-021:** suíte de testes serial (`fileParallelism: false`) — paralelismo, mesmo
  limitado por thread, gerava overhead de orquestração do Testcontainers grande demais pro
  Docker Desktop desta máquina (não é falta de memória do container em si).
- **ADR-022:** escrita de política é síncrona do ponto de vista da rota
  (`executarEscritaPoliticaSincrona`, `QueueEvents`/`waitUntilFinished`) — a rota HTTP
  enfileira e espera o resultado; um worker dedicado novo (`worker:policy-write`) é quem
  chama `salvarPolitica` de verdade.
- **ADR-023:** `POST /policies` desfaz o INSERT local quando a AMAPI recusa o payload — nunca
  fica uma linha "fantasma" sem `amapiName`.
- **ADR-024:** dado sensível (`novaSenha` do RESET_PASSWORD) nunca é persistido em
  `comandos.payload` — histórico de comando usa allowlist, não cópia do body.
- **ADR-025:** dois gaps de RBAC não cobertos pela spec, resolvidos por extensão do padrão já
  confirmado (ADR-004): `RELINQUISH_OWNERSHIP` é `ADMIN`-only (mesmo nível de `WIPE`); CRUD de
  `colaboradores`/`linhas` segue leitura `VIEWER+`/escrita `TECNICO+`/`AUDITOR` de fora.
- **ADR-026:** localização fora de escopo na Fase 6 (perguntado ao Victor, que confirmou) — a
  AMAPI não coleta localização continuamente, só via "Lost Mode" dedicado, não implementado.
- **ADR-027:** `alertas.dispositivo_id` virou nullable + `linha_id` novo (com CHECK garantindo
  exatamente um dos dois) — `LINHA_SEM_USO` (seção 9) não tem dispositivo por definição.
- **ADR-028:** `AUDITOR` ganha acesso a `GET /alertas`/`GET /dashboard` — primeira rota a usar
  a permissão `compliance:ler`, declarada desde a Fase 2 mas nunca antes exercida.
- **ADR-029:** `BATERIA_DEGRADADA` mede carga crítica no momento do check-in, não degradação
  física — a AMAPI não expõe saúde/desgaste de bateria, só percentual de carga.
- **ADR-030:** `SO_OBSOLETO` compara versão "major" do Android via tabela SDK→versão — a AMAPI
  não expõe nível de API (SDK) diretamente, só a versão "visível ao usuário".
- **ADR-031:** limiares do motor de alertas (dias sem check-in, MB crítico, % de bateria etc.)
  são env vars com default, não valores fixos — a seção 9 nomeia os tipos, não os números.

## Estado atual

**Revisão completa do backend + rodada de eficiência (20 achados, 6 lotes): concluída e
validada contra o GitHub real, "0 erros" confirmado.** Depois da revisão de 15 bugs
(abaixo), o Victor perguntou especificamente sobre eficiência — resposta honesta: a
revisão anterior tinha sido só de correção, e tinha 5 achados de eficiência/robustez
deixados de lado de propósito (não eram bugs). Pedido explícito de resolver todos,
"0 erros, nada deixado de lado". Lote 6 resolveu:

**Lote 6 — Eficiência/robustez** — `GET /dashboard` com 10 queries sequenciais → paralelas
(`Promise.all`); busca livre (`?busca=`) em 4 endpoints sem escapar `%`/`_` do ILIKE
(helper compartilhado novo, `src/shared/sql-like.ts`); corrida real no token de
enrollment (SELECT+checar+UPDATE não-atômico — corrigido com `UPDATE ... WHERE
   usado_em IS NULL`, testado disparando a corrida de verdade via `Promise.allSettled`
contra Postgres real); vazamento de 3 conexões Redis no shutdown do processo da API
(nunca fechava a fila de política); 409 sistêmico pra qualquer violação de unicidade
do Postgres (SQLSTATE 23505) no error handler global, fechando a janela de corrida
check-then-insert residual pra matrícula/número/patrimônio de uma vez, não rota por
rota. 321 testes (11 novos), CI e CodeQL verdes no commit `ffa31b0`.

**Revisão completa do backend (15 bugs, 5 lotes): concluída e validada contra o GitHub
real.** Pedido explícito do Victor antes de liberar o frontend ("a empresa tem mais de
mil funcionários, precisa estar rodando liso") — revisão adversarial dedicada (não só
"os testes passam") encontrou 15 bugs reais de correção/segurança que a suíte de 283
testes da época não cobria. Corrigidos em 5 commits temáticos, cada um com teste novo
que prova o bug E a correção, validado isoladamente antes do commit seguinte:

1. **Segurança** — RBAC rodava depois da validação de schema (400 revelava campos de
   rota protegida pra quem nem autenticou, em vez de 401); vazamento de senha no log
   via erro bruto do googleapis.
2. **Contrato de API** — `?ativo=false`/`?ativa=false`/`?aberto=false` faziam o
   contrário do pedido (`z.coerce.boolean()`); paginação de `/alertas` nunca avançava
   (cursor invertido); `valorMensal` de `/linhas` voltava como string, não número.
3. **Motor de alertas** — app desinstalado nunca era detectado como ausente
   (`dispositivo_apps` nunca apagava linha antiga); `APP_OBRIGATORIO_AUSENTE` nunca se
   resolvia sozinho quando a política mudava ou o device era desvinculado.
4. **Integridade com a AMAPI** — escrita de política + histórico de versão não eram
   atômicos (sem transação); timeout do BullMQ perdia o resultado real do job (que
   continua rodando) — agora reconcilia depois via `aposTimeout`; comando sem nome de
   operação ficava "ENVIADO" pra sempre, sem erro visível.
5. **Config/robustez** — primeiro ADMIN podia travar como VIEWER por maiúscula/
   minúscula; config de domínio malformada podia zerar login da empresa sem erro no
   boot; patrimônio duplicado quebrava com 500 em vez de 409; redelivery do Pub/Sub
   nunca tentava reprocessar erro transitório; fuso do export Excel usava UTC.

**Confirmado contra a infraestrutura real** (não assumido): depois do push final, o job
`openapi-sincronizado` do CI pegou — pela segunda vez nesta jornada, exatamente como
projetado — uma divergência real (o fix dos filtros booleanos mudou o schema de 3 query
params, e o `openapi.json` não tinha sido regenerado). Corrigido num commit extra.
Resultado final: **310 testes, CI e CodeQL verdes** no commit `90cf9b5`.

**Camada de automação (pós-Fase 7): concluída, e já validada contra o GitHub real.**
Primeiro push (histórico completo, o repositório remoto estava vazio desde a Fase 1) e
primeira execução real do CI/CodeQL revelaram 3 bugs que só apareciam fora da máquina
local (ver entrada "Diagnóstico pós-push" abaixo) — corrigidos e CI **verde** no commit
`b5ed2b3`. CI (lint/format/typecheck/build/testes/deriva do openapi.json) no GitHub
Actions, pre-commit hooks (husky+lint-staged), Dependabot, CodeQL, exportação Excel do
dashboard e `render.yaml` como infraestrutura-como-código pro deploy real (Render pro
backend, Vercel reservado pro frontend).

**Fase 7 — Documentação de handoff: concluída.**

Os 6 entregáveis da Fase 7 existem em `docs/`: `openapi.json` (gerado do código, não
escrito à mão — ver `npm run docs:openapi`), `ARQUITETURA.md`, `OPERACAO.md`, `LGPD.md`,
`APRESENTACAO-GERENCIA.md`, `HANDOFF-FRONTEND.md`. Ver entrada "Fase 7" abaixo para o
detalhe completo do que cada um cobre e o que ficou registrado como pendência dentro
deles (não pendências novas de código, pendências de decisão de negócio/jurídica/infra
documentadas para quem for ler cada documento).

**Fase 6 — Motor de alertas, dashboard e LGPD: concluída.**

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
- 133 testes (unitários + integração com Testcontainers reais), cobertura 94,7%
  statements/lines, 97,2% functions, 88,1% branches, 100% em `src/plugins/rbac.ts` **e**
  `src/domain/policy/policy-invariants.ts` (as duas metas de 100% da seção 14 cumpridas).

**Fase 3 — Adapter AMAPI + Invariantes**, adicionado a tudo acima:

- **`enforceInvariants`** (`src/domain/policy/policy-invariants.ts`) — o invariante de apps
  não-removíveis da seção 3, com correção técnica real (ADR-015): força
  `uninstallAppsDisabled: true` a nível de política (mecanismo que de fato existe e funciona
  na AMAPI atual) + `uninstallBlocked: true` por app (defensivo, campo não confirmado no
  schema). Valida `installType` por app. 100% de cobertura, 17 testes incluindo bypass e
  rollback de versão antiga.
- **Adapter AMAPI completo** (`src/integrations/amapi/`): `client.ts` (singleton
  autenticado), `policies.ts` (get/list/delete/patch — patch sempre via `enforceInvariants`),
  `devices.ts` (get/list/patch de política/delete-como-wipe), `commands.ts`
  (LOCK/REBOOT/RESET_PASSWORD/RELINQUISH_OWNERSHIP/CLEAR_APP_DATA + wipe),
  `enrollment.ts` (criação de token com `additionalData`/`oneTimeOnly`/
  `allowPersonalUsage`), `mappers.ts` (formatação de duração por campo, ADR-002),
  `retry.ts` (backoff exponencial + jitter, 429/5xx, máx. 5 tentativas — 4xx que não seja 429
  nunca retry). Nenhum controller importa `googleapis` direto.
- **Fila serializada de escrita de política** (`src/queues/policy-write-queue.ts`, BullMQ,
  concorrência 1) — testado de verdade que nunca processa dois jobs em paralelo.
- **Seed das duas políticas padrão** (`npm run db:seed`,
  `src/db/seed/politicas-padrao.ts`) — idempotente, valores em aberto documentados (ADR-016).

**Fase 4 — Inventário e Pub/Sub**, adicionado a tudo acima:

- **Consumer Pub/Sub** (`src/workers/pubsub-consumer.ts`, processo dedicado —
  `npm run worker:pubsub`) — formato real da mensagem confirmado contra a doc oficial do
  Google (ADR-017: `notificationType` em `attributes`, `data` é o recurso cru). Grava toda
  mensagem em `eventos_brutos` (idempotente por `messageId`) ANTES de processar, despacha por
  tipo dentro de uma transação, só faz `ack()` depois do commit, `nack()` em erro. Watchdog de
  15min sem atividade. Núcleo de processamento (`src/domain/eventos/processar-evento.ts`)
  compartilhado com o replay manual.
- **Handler `ENROLLMENT`** (`src/domain/eventos/handlers/enrollment.ts`) — correlaciona via
  `Device.enrollmentTokenData` (= `additionalData` gravado na criação do token), cria o
  dispositivo já vinculado (colaborador/patrimônio/política), marca o token como usado.
  **Critério de aceite da fase cumprido e testado contra Postgres real** (Testcontainers):
  enrollment de device de teste popula o banco sozinho.
- **Handler `STATUS_REPORT`** (`src/domain/eventos/handlers/status-report.ts`) — atualiza
  campos do dispositivo (mappers com 3 divergências reais documentadas, ADR-019), upsert de
  `dispositivo_apps`, abre `APP_OBRIGATORIO_AUSENTE` quando falta um app `FORCE_INSTALLED` da
  política — idempotente via índice único parcial (ADR-020), não check-then-insert.
- **`GET /devices`** (filtros + cursor), **`GET /devices/:id`**, **`PATCH /devices/:id`**
  (vínculo administrativo), **`GET /devices/:id/{apps,comandos,auditoria}`** — `AUDITOR`
  explicitamente EXCLUÍDO de todas (ADR-004, achei que tinha esquecido essa regra já
  confirmada e corrigi antes de fechar a fase).
- **`GET /auditoria`** (novo, não estava no plano original desta fase) — visão global da
  trilha de auditoria, é o único acesso do papel `AUDITOR` a qualquer coisa no sistema
  (consequência direta do ADR-004).
- **`POST /internal/pubsub/replay`** e **`POST /internal/sync/devices`** (só `ADMIN`) —
  reprocessamento manual de eventos falhos e reconciliação completa contra a AMAPI.
- Documentação por tópico pra quem for construir a interface: `docs/api/{pubsub-pipeline,
devices,internal,auditoria}.md`.
- 200 testes (unitários + integração com Testcontainers reais) — cobertura completa na Fase 4.

**Fase 5 — Políticas, comandos e cadastros**, adicionado a tudo acima:

- **CRUD de políticas** (`src/modules/politicas/politicas.routes.ts`) —
  `GET/POST/PATCH/DELETE /policies`, `GET /policies/:id/versoes`, `POST /policies/:id/rollback`.
  Toda escrita passa por `enforceInvariants` (auditando overrides via
  `POLITICA_INVARIANT_OVERRIDE` quando algo é corrigido) e pela fila serializada, agora
  **de fato conectada** a um worker dedicado (`npm run worker:policy-write`, ADR-022) — a Fase
  3 tinha deixado fila e adapter prontos, mas nada os usava até agora. `DELETE` é soft
  (`ativa: false`, nunca apaga — preserva `politicas_versoes`); `POST` desfaz o INSERT local se
  a AMAPI recusar o payload (ADR-023). Só `ADMIN` escreve.
- **`POST /devices/:id/comandos`** (`src/modules/devices/devices.routes.ts`) — emissão de
  verdade dos 6 tipos (LOCK/REBOOT/RESET_PASSWORD/CLEAR_APP_DATA/RELINQUISH_OWNERSHIP/WIPE).
  `WIPE` exige dupla confirmação (patrimônio + motivo ≥ 20 caracteres) e é `ADMIN`-only, junto
  com `RELINQUISH_OWNERSHIP` (gap de RBAC resolvido por extensão de padrão, ADR-025). Dado
  sensível (`novaSenha`) nunca é persistido no histórico (ADR-024). Rate limit de 10/min
  específico da rota (seção 11), desligado em ambiente de teste.
- **Handler `COMMAND`** (`src/domain/eventos/handlers/command.ts`) — fecha o ciclo assíncrono
  dos comandos: correlaciona a `Operation` da AMAPI por `amapiOperationName`, marca
  `SUCESSO`/`FALHA` só quando `done: true`. Registrado no dispatcher do Pub/Sub
  (`processar-evento.ts`), que ficou "sem handler" pra este tipo desde a Fase 4.
- **CRUD de colaboradores** (`src/modules/colaboradores/`) e **linhas**
  (`src/modules/linhas/`) — cadastro organizacional completo (seção 6), paginação por cursor,
  `AUDITOR` de fora dos dois (ADR-025).
- Documentação por tópico nova: `docs/api/{politicas,comandos,colaboradores-e-linhas}.md`.
- 241 testes (unitários + integração com Testcontainers reais), cobertura 92,75%
  statements/lines, 97,05% functions, 81,49% branches; 100% mantido em `src/plugins/rbac.ts`,
  `src/domain/policy/policy-invariants.ts` **e** `src/integrations/amapi/mappers.ts`.

**Fase 6 — Motor de alertas, dashboard e LGPD**, adicionado a tudo acima:

- **Motor de alertas** (`src/domain/alertas/motor.ts`) — os 8 tipos restantes da seção 9 (o 9º,
  `APP_OBRIGATORIO_AUSENTE`, já existia desde a Fase 4). Dividido em dois mecanismos: 5 tipos
  **reativos** (`NAO_CONFORME`, `PATCH_DESATUALIZADO`, `SO_OBSOLETO`, `STORAGE_CRITICO`,
  `BATERIA_DEGRADADA`) checados a cada `STATUS_REPORT`, abrindo OU resolvendo sozinhos; 3 tipos
  **periódicos** (`SEM_CHECKIN`, `DISPOSITIVO_ORFAO`, `LINHA_SEM_USO`) via scan completo da
  frota, sobre AUSÊNCIA de algo que nenhum evento reativo detecta. Todos os limiares são env
  vars com default (ADR-031) — a spec não fixa nenhum número.
- **`src/workers/manutencao-worker.ts`** (`npm run worker:manutencao`) — roda os 3 scans
  periódicos + a purga LGPD a cada `ALERTA_SCAN_INTERVALO_HORAS` (default 6h).
  `POST /internal/alertas/verificar` e `POST /internal/lgpd/purgar` (`ADMIN`) disparam ambos
  manualmente, sem esperar o próximo ciclo.
- **Duas divergências reais da AMAPI encontradas e documentadas ANTES de implementar** (regra
  8 da spec): `BATERIA_DEGRADADA` na verdade mede carga crítica, não degradação física — a
  AMAPI não expõe saúde de bateria (ADR-029). `SO_OBSOLETO` compara via uma tabela SDK→versão
  major, porque a AMAPI só expõe a versão "visível ao usuário", não o nível de API (ADR-030).
- **Gap de schema real encontrado**: `LINHA_SEM_USO` (seção 9) não tem dispositivo associado
  por definição, mas `alertas.dispositivo_id` era `NOT NULL` (seção 6). Corrigido tornando o
  campo nullable + `linha_id` novo, com `CHECK` garantindo exatamente um dos dois preenchido
  (ADR-027).
- **`GET /alertas`, `POST /alertas/:id/{reconhecer,resolver}`** — ciclo de vida manual. `GET
/dashboard` — resumo agregado (contagens por compliance/alerta/linha). Os dois aceitam
  `AUDITOR` — primeira vez que a permissão `compliance:ler` (declarada desde a Fase 2) é
  exercida de verdade (ADR-028).
- **LGPD**: perguntei ao Victor antes de implementar (regra 8) se a Fase 6 deveria adicionar
  comandos de "Lost Mode" pra coleta de localização real — a AMAPI não coleta localização
  continuamente como o esquema original supunha, só nesse recurso específico e pouco usado.
  Confirmado deixar de fora (ADR-026): a fase só implementa a purga real que já é possível,
  `eventos_brutos` antigos (`RETENCAO_EVENTOS_BRUTOS_DIAS`).
- Documentação por tópico nova: `docs/api/{alertas,dashboard}.md`.
- 281 testes (unitários + integração com Testcontainers reais), cobertura 92,57%
  statements/lines, 96,29% functions, 81,65% branches; 100% mantido em `src/plugins/rbac.ts`,
  `src/domain/policy/policy-invariants.ts` **e** `src/integrations/amapi/mappers.ts`.

Ainda não existe (por fase futura): documentação de handoff (Fase 7). `client.ts`/o consumer/o
adapter de comandos nunca foram exercitados contra a AMAPI/Pub/Sub reais (sem
enterprise/subscription reais — ADR-005); testados mockando a fronteira de rede. Nenhuma
coleta de localização real (ADR-026, fora de escopo por decisão do Victor).

## Pendências conhecidas (bloqueiam fases específicas, não a Fase 6)

| Pendência                                                                                  | Bloqueia                                               | Situação                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Nome real da enterprise AMAPI (`enterprises/LC...`)                                        | Teste E2E real contra a AMAPI e o Pub/Sub              | Placeholder no `.env.example`; empresa vai confirmar                                                                       |
| Nome do tópico/subscription Pub/Sub                                                        | Idem — consumer só roda contra evento sintético hoje   | Arquivado — depende de conversa com equipe de frontend/infra                                                               |
| Valores exatos do enum `MemoryEventType` (bateria/storage)                                 | Precisão de `bateriaPct`/`storageLivreMb`              | ADR-019 — heurística tolerante até validar contra device real                                                              |
| Lista de filiais existentes                                                                | Relatórios por filial mais detalhados (Fase 7?)        | Arquivado — depende de conversa com equipe de frontend/infra                                                               |
| Limiares do motor de alertas são palpites, não medição real                                | Ajuste fino de ruído (alertas demais/de menos)         | ADR-031 — revisar assim que houver volume real de uso                                                                      |
| Lista fechada de operadoras                                                                | `linhas.operadora`                                     | Decisão: campo texto livre, sem enum — "todas as operadoras famosas atualmente, de um modo geral"                          |
| Diferenciação entre políticas `administrativo`/`operacao-campo` e lista de apps por perfil | CRUD de políticas                                      | Seed nasce com payload idêntico nas duas — ADR-016, decisão de negócio pendente (agora editável via `PATCH /policies/:id`) |
| Recurso "Lost Mode" (localização real de device perdido)                                   | Nenhuma — fora de escopo até ser pedido explicitamente | ADR-026, decisão confirmada com o Victor                                                                                   |

## Problemas conhecidos

Nenhum em aberto no código. Um foi corrigido durante a Fase 2 (ADR-008), outro durante a Fase
3 (ADR-015), dois durante a Fase 4 (RBAC do `AUDITOR`, ADR-004; infra de teste, ADR-021), e
dois durante a Fase 5 (linha fantasma em `politicas`, ADR-023; `UNDEFINED_VALUE` no driver
Postgres). Nenhum problema novo na Fase 6 — as duas divergências da AMAPI encontradas
(`BATERIA_DEGRADADA`, `SO_OBSOLETO`) e o gap de schema (`LINHA_SEM_USO`) foram achados e
resolvidos ANTES de implementar, não depois (ADR-026/027/029/030).

## Próximo passo

**Backend formalmente liberado pro frontend, "0 erros" confirmado** (2026-10-15) — 321
testes, 20 achados reais corrigidos entre as duas revisões (15 de correção/segurança +
5 de eficiência/robustez), não só "os testes passam". CI e CodeQL verdes contra o
GitHub real, não só localmente — confirmado de novo depois de cada rodada. Fase 7
concluída — era a última
fase da spec original. Não há próxima fase definida pela spec. Dois caminhos possíveis
a partir daqui:

1. **Construção da interface** pelo time de frontend, usando `docs/HANDOFF-FRONTEND.md` +
   `docs/openapi.json` como ponto de partida (este repositório continua só-backend).
   **Liberado para começar de verdade** — só falta decidir a stack do frontend
   (provavelmente algo Vercel-nativo, ex. Next.js ou Vite+React).
2. **Teste E2E real contra a AMAPI**, bloqueado pelas mesmas 3 pendências arquivadas desde
   a Fase 4/5 (nome real da enterprise AMAPI, tópico/subscription Pub/Sub, lista de
   filiais) — nenhuma resolvível pela equipe técnica sozinha, ver `docs/APRESENTACAO-GERENCIA.md`.

Nenhuma pendência de código bloqueia nenhum dos dois caminhos.

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

---

### 2026-09-05 — Fase 3: Adapter AMAPI + Invariantes

**Solicitação original:** "inicie a fase 3" (na mesma mensagem que pediu os commits
separados e as correções pontuais acima).

**Status:** Concluída.

**O que foi realizado:**

- `enforceInvariants` (seção 3) — com uma correção técnica real descoberta e confirmada
  ANTES de implementar (não depois): `uninstallBlocked` por app não existe no schema atual da
  AMAPI (conferido no cliente oficial `googleapis` e na documentação REST do Google). O
  mecanismo real é `uninstallAppsDisabled` a nível de política. Perguntei ao Victor antes de
  decidir sozinho; ele pediu pra manter os dois campos (o real + o defensivo). Ver ADR-015.
- Adapter AMAPI completo: `client.ts`, `policies.ts`, `devices.ts`, `commands.ts`,
  `enrollment.ts`, `mappers.ts`, `retry.ts` — todos em `src/integrations/amapi/`.
- Fila BullMQ serializada (`src/queues/policy-write-queue.ts`), concorrência 1, testada de
  verdade contra Redis real via Testcontainers.
- Seed das duas políticas padrão, idempotente.

**Arquivos criados:** `src/domain/policy/policy-invariants.ts`;
`src/integrations/amapi/{client,policies,devices,commands,enrollment,mappers,retry}.ts`;
`src/queues/policy-write-queue.ts`; `src/db/seed/politicas-padrao.ts`;
`test/unit/{policy-invariants,amapi-client,amapi-policies,amapi-devices,amapi-commands,amapi-enrollment,amapi-retry}.test.ts`;
`test/integration/{policy-write-queue,seed-politicas-padrao}.test.ts`.

**Arquivos alterados:** `src/config/env.ts` (`AMAPI_ENTERPRISE_NAME`,
`AMAPI_SERVICE_ACCOUNT_KEY_PATH` — agora validados e consumidos de verdade), `.env.example`,
`vitest.config.ts` (threshold 100% em `policy-invariants.ts`), `package.json`
(`googleapis`, `bullmq`, script `db:seed`), `docs/DECISOES.md` (ADR-015, ADR-016).

**Arquivos removidos:** nenhum.

**Funcionalidades afetadas:** nenhuma das Fases 1/2 — só adição.

**Decisões técnicas tomadas:** ADR-015 (uninstallBlocked não existe, decisão confirmada com
o Victor), ADR-016 (valores em aberto no seed).

**Impacto da alteração:** nenhuma regressão — Fases 1/2 revalidadas junto de cada rodada de
testes desta fase.

**Validação realizada:**

- `npm run typecheck`/`lint`/`build`/`format:check` — limpos.
- `npm test` — 133/133 passando.
- `npm run test:coverage` — 94,7% statements/lines, 97,2% functions, 88,1% branches; 100% em
  `src/plugins/rbac.ts` **e** `src/domain/policy/policy-invariants.ts` (as duas metas
  explícitas de 100% da seção 14).
- Achei e corrigi 3 bugs reais nos meus PRÓPRIOS testes durante a validação (mocks
  compartilhados sem reset entre `it()`, comparação de token puro contra hash armazenado) —
  documentado aqui porque é exatamente o tipo de coisa que "só rodar os testes e ver verde"
  não pega sozinho; peguei porque assumi valores calculados errados e conferi manualmente.

**Problemas encontrados:** um — ver ADR-015 (`uninstallBlocked` não existe na AMAPI atual).
Achado ANTES de implementar (não depois), consultando a documentação oficial do Google.

**Pendências futuras:** ver tabela "Pendências conhecidas" acima. Antes da Fase 4: tópico/
subscription Pub/Sub (ADR-005).

---

### 2026-09-06 — Fase 4: Inventário e Pub/Sub

**Solicitação original:** "retome" (na sessão anterior, após a conclusão da Fase 3 — a regra
de trabalho por fases da própria spec já apontava a Fase 4 como próximo passo natural).

**Status:** Concluída.

**O que foi realizado:**

- Consumer Pub/Sub completo (`src/workers/pubsub-consumer.ts`) com formato de mensagem
  confirmado contra a documentação oficial do Google ANTES de implementar (ADR-017) — a seção
  8 original não especificava onde `notificationType` vive nem que `data` é o recurso cru.
- Handlers `ENROLLMENT` (critério de aceite da fase, testado contra Postgres real) e
  `STATUS_REPORT` (upsert de apps + alerta `APP_OBRIGATORIO_AUSENTE`, idempotente via índice
  único parcial — ADR-020).
- Mapeamento `Device`/`ApplicationReport` → schema interno, com 3 divergências reais achadas
  e documentadas ANTES de implementar (ADR-019).
- Coluna `dispositivos.ativo` (gap seção 6/10, mesmo padrão do ADR-011 — ver ADR-018).
- Endpoints de leitura/vínculo de `/devices`, `/internal/pubsub/replay`,
  `/internal/sync/devices`, e `GET /auditoria` (não previsto no plano original desta fase —
  criado como consequência direta de corrigir o ADR-004, ver abaixo).
- 4 markdowns de documentação por tópico em `docs/api/` (pipeline Pub/Sub, devices, internal,
  auditoria) — pedido explícito do Victor nesta retomada ("a cada tópico, faça um markdown").
- `mappers.ts` (Fase 3) atingiu 100% de cobertura de branch pela primeira vez, exigência da
  seção 14 agora que a AMAPI mapeia device de verdade — refatorado pra eliminar um branch
  morto (`?? ''` num `.sort()` cujo `.filter()` anterior já garantia não-nulo).

**Arquivos criados:** `src/workers/{watchdog,pubsub-consumer}.ts`;
`src/domain/eventos/{processar-evento,handlers/enrollment,handlers/status-report}.ts`;
`src/domain/{dispositivos,alertas,comandos}/repositorio.ts`;
`src/modules/{devices/devices.routes,internal/internal.routes,auditoria/auditoria.routes}.ts`;
`drizzle/migrations/{0002_dispositivos_ativo,0003_alertas_aberto_unico}.sql`;
`test/unit/{watchdog,pubsub-consumer,amapi-mappers}.test.ts`;
`test/integration/{fase4-inventario,devices-routes}.test.ts`; `docs/api/{README,
pubsub-pipeline,devices,internal,auditoria}.md`.

**Arquivos alterados:** `src/db/schema/{dispositivos,alertas}.ts` (colunas/índice novos),
`src/domain/auditoria/registrar.ts` (`listarAuditoria` genérica, filtrável — a base do
`GET /auditoria` novo), `src/integrations/amapi/mappers.ts` (mapeamento de Device/apps +
refatoração pra 100% de branch), `src/config/env.ts`/`.env.example`/`test/setup.ts`
(`GOOGLE_CLOUD_PROJECT`, `PUBSUB_SUBSCRIPTION`), `src/app.ts` (registro das 3 rotas novas),
`package.json` (`@google-cloud/pubsub`, script `worker:pubsub`), `vitest.config.ts` (100% em
`mappers.ts`; `fileParallelism: false`, ADR-021), `README.md`/`docs/SETUP.md` (Fase 4 +
troubleshooting de Testcontainers), `docs/DECISOES.md` (ADR-017 a ADR-021).

**Arquivos removidos:** nenhum.

**Funcionalidades afetadas:** nenhuma das Fases 1–3 — só adição, exceto a correção de RBAC
abaixo (rotas desta própria fase, nunca chegaram a ser usadas por ninguém).

**Decisões técnicas tomadas:** ADR-017 a ADR-021 (ver "Decisões técnicas tomadas" acima).

**Impacto da alteração:** nenhuma regressão nas Fases 1–3 — revalidadas junto de cada rodada
de testes desta fase.

**Validação realizada:**

- `npm run typecheck`/`lint`/`build`/`format:check` — limpos.
- `npm test` — 200/200 passando (23 arquivos, suíte serial, ADR-021; ~6min com o Docker
  Desktop saudável).
- `npm run test:coverage` — 93,8% statements/lines, 98,2% functions, 84,8% branches; 100% em
  `src/plugins/rbac.ts`, `src/domain/policy/policy-invariants.ts` **e**, pela primeira vez,
  `src/integrations/amapi/mappers.ts` (as três metas explícitas de 100% da seção 14
  cumpridas).
- Critério de aceite explícito da fase confirmado contra Postgres real via Testcontainers:
  enrollment de device de teste popula `dispositivos` com o vínculo correto, sozinho, sem
  nenhuma ação manual depois.

**Problemas encontrados:** dois, ambos corrigidos antes de fechar a fase — ver "Problemas
conhecidos" acima (RBAC do `AUDITOR` corrigido, ADR-004; infra de teste ajustada, ADR-021).

**Pendências futuras:** ver tabela "Pendências conhecidas" acima. Nenhuma bloqueia o início
da Fase 5.

---

### 2026-09-07 — Fase 5: Políticas, comandos e cadastros

**Solicitação original:** "prossiga para a fase 5".

**Status:** Concluída.

**O que foi realizado:**

- CRUD de políticas completo, finalmente conectando a fila serializada e o adapter que a Fase
  3 tinha deixado prontos como biblioteca — nada os usava até agora (ADR-022, worker dedicado
  novo).
- `POST /devices/:id/comandos` — emissão de verdade dos 6 tipos de comando, com dupla
  confirmação pro `WIPE` e RBAC extra por tipo (`ADMIN`-only pra `WIPE`/`RELINQUISH_OWNERSHIP`,
  gap de spec resolvido por extensão do ADR-004 — ver ADR-025).
- Handler `COMMAND` do Pub/Sub, fechando o ciclo assíncrono que a Fase 4 deixou "sem handler"
  de propósito.
- CRUD de colaboradores e linhas.
- 3 novos documentos de API por tópico, atendendo pedido explícito do Victor ("a cada tópico,
  faça um markdown") — retomado desta mesma instrução, dada durante o fechamento da Fase 4.

**Arquivos criados:** `src/modules/{politicas/politicas.routes,colaboradores/colaboradores.routes,linhas/linhas.routes}.ts`;
`src/domain/{colaboradores,linhas}/repositorio.ts`; `src/domain/eventos/handlers/command.ts`;
`src/workers/policy-write-worker.ts`;
`test/integration/{politicas-routes,comandos-devices,colaboradores-linhas-routes}.test.ts`;
`docs/api/{politicas,comandos,colaboradores-e-linhas}.md`.

**Arquivos alterados:** `src/queues/policy-write-queue.ts` (`QueueEvents`,
`executarEscritaPoliticaSincrona`, ADR-022), `src/domain/eventos/processar-evento.ts`
(handler `COMMAND` registrado, `resource` generalizado pra `unknown`), `src/modules/devices/
devices.routes.ts` (`POST /devices/:id/comandos`), `src/app.ts` (registro das 3 rotas novas),
`package.json` (script `worker:policy-write`), `README.md`/`docs/api/{README,devices}.md`,
`docs/DECISOES.md` (ADR-022 a ADR-025).

**Arquivos removidos:** nenhum.

**Funcionalidades afetadas:** nenhuma das Fases 1–4 — só adição.

**Decisões técnicas tomadas:** ADR-022 a ADR-025 (ver "Decisões técnicas tomadas" acima).

**Impacto da alteração:** nenhuma regressão — Fases 1–4 revalidadas junto de cada rodada de
testes desta fase.

**Validação realizada:**

- `npm run typecheck`/`lint`/`build`/`format:check` — limpos.
- `npm test` — 241/241 passando (26 arquivos).
- `npm run test:coverage` — 92,75% statements/lines, 97,05% functions, 81,49% branches; 100%
  mantido em `src/plugins/rbac.ts`, `src/domain/policy/policy-invariants.ts` **e**
  `src/integrations/amapi/mappers.ts`.
- Achei e corrigi 2 bugs reais durante a própria escrita dos testes de integração — ver
  "Problemas conhecidos" acima (linha fantasma em `politicas`; `UNDEFINED_VALUE` no handler
  `COMMAND`). Nos dois casos o bug só apareceu porque o teste exercitou o caminho de falha de
  verdade (AMAPI simulada recusando payload; `Operation` sem erro), não só o caminho feliz.

**Problemas encontrados:** dois, ambos corrigidos antes de fechar a fase — ver "Problemas
conhecidos" acima.

**Pendências futuras:** ver tabela "Pendências conhecidas" acima. Nenhuma bloqueia o início
da Fase 6.

---

### 2026-09-08 — Fase 6: Motor de alertas, dashboard e LGPD

**Solicitação original:** "podemos seguir para fase 6."

**Status:** Concluída.

**O que foi realizado:**

- Motor de alertas completo — os 8 tipos restantes da seção 9, divididos em reativos (5,
  checados a cada `STATUS_REPORT`) e periódicos (3, scan da frota via
  `worker:manutencao`/`ALERTA_SCAN_INTERVALO_HORAS`).
- Antes de implementar, encontrei e documentei 3 divergências reais entre a spec e a AMAPI
  (regra 8 — avisar antes, com referência): localização não é coletada continuamente (só via
  "Lost Mode", perguntei ao Victor e ele confirmou deixar fora de escopo — ADR-026);
  `BATERIA_DEGRADADA` não pode medir degradação física (só carga — ADR-029); `SO_OBSOLETO`
  precisa de uma tabela SDK→versão porque a AMAPI não expõe nível de API (ADR-030).
- Encontrado um gap real de schema: `LINHA_SEM_USO` não tem dispositivo por definição, mas
  `alertas.dispositivo_id` era `NOT NULL`. Corrigido com uma migration (nullable + `linha_id`
  novo + `CHECK`), não contornado.
- `GET /alertas` e `GET /dashboard` — primeira vez que a permissão `compliance:ler` (declarada
  desde a Fase 2, nunca usada) ganha uma rota de verdade, com `AUDITOR` incluído (ADR-028).
- Purga LGPD de `eventos_brutos` antigos.

**Arquivos criados:** `src/domain/alertas/motor.ts`; `src/domain/lgpd/retencao.ts`;
`src/workers/manutencao-worker.ts`; `src/modules/{alertas/alertas.routes,
dashboard/dashboard.routes}.ts`; `src/domain/dashboard/repositorio.ts`;
`drizzle/migrations/0004_alertas_linha_sem_uso.sql`;
`test/integration/{motor-alertas,alertas-dashboard-routes}.test.ts`;
`docs/api/{alertas,dashboard}.md`.

**Arquivos alterados:** `src/db/schema/alertas.ts` (`linha_id`, `dispositivo_id` nullable,
`CHECK`), `src/domain/alertas/repositorio.ts` (`resolverAlertaSeAberto`,
`resolverAlertaDeLinhaSeAberto`, `listarAlertas`, target dinâmico no `onConflictDoNothing`),
`src/domain/eventos/handlers/status-report.ts` (chama `verificarAlertasReativos`; resolve
`APP_OBRIGATORIO_AUSENTE` quando o app volta — gap da própria Fase 4 fechado aqui),
`src/modules/internal/internal.routes.ts` (`/internal/alertas/verificar`,
`/internal/lgpd/purgar`), `src/config/env.ts`/`.env.example` (limiares de alerta + retenção),
`src/app.ts`, `package.json` (`worker:manutencao`), `README.md`, `docs/DECISOES.md` (ADR-026 a
ADR-031).

**Arquivos removidos:** nenhum.

**Funcionalidades afetadas:** `APP_OBRIGATORIO_AUSENTE` (Fase 4) ganhou auto-resolução, que
não existia antes — não é regressão, é o mesmo alerta completando o ciclo de vida que os 8
novos já tinham desde o início.

**Decisões técnicas tomadas:** ADR-026 a ADR-031 (ver "Decisões técnicas tomadas" acima).

**Impacto da alteração:** nenhuma regressão nas Fases 1–5 — revalidadas junto de cada rodada
de testes desta fase.

**Validação realizada:**

- `npm run typecheck`/`lint`/`build`/`format:check` — limpos.
- `npm test` — 281/281 passando (28 arquivos).
- `npm run test:coverage` — 92,57% statements/lines, 96,29% functions, 81,65% branches; 100%
  mantido em `src/plugins/rbac.ts`, `src/domain/policy/policy-invariants.ts` **e**
  `src/integrations/amapi/mappers.ts`.
- Critério informal desta fase confirmado contra Postgres real: um dispositivo `NON_COMPLIANT`
  abre `NAO_CONFORME` sozinho e fecha sozinho quando volta a ficar `COMPLIANT`, sem nenhuma
  ação manual — mesmo padrão de "critério de aceite" das fases anteriores.

**Problemas encontrados:** nenhum bug de código — as 3 divergências da AMAPI e o gap de schema
foram achados e resolvidos ANTES de implementar (ver "Decisões técnicas tomadas"), não depois.

**Pendências futuras:** ver tabela "Pendências conhecidas" acima. Nenhuma bloqueia o início
da Fase 7.

---

### 2026-10-14 — Fase 7: Documentação de handoff

**Solicitação original:** recuperar o projeto (fora da sessão de trabalho padrão do
Victor, achado por busca no sistema de arquivos) e prosseguir pra Fase 7 — pedido
explícito de explicar cada passo em detalhe, por ser a primeira vez do Victor com este
tipo de projeto.

**Status:** Concluída.

**O que foi realizado:**

- **`docs/openapi.json`** — gerado a partir do próprio código (schemas Zod de cada rota
  via `fastify-type-provider-zod` + `@fastify/swagger`), não escrito à mão. Script novo
  `scripts/gerar-openapi.ts` (`npm run docs:openapi`) constrói a app via `buildApp()` e
  chama `app.swagger()` — exige Postgres/Redis alcançáveis (nenhuma query roda de
  verdade, mas o cliente Redis conecta no import do módulo, `lazyConnect: false`). 39
  combinações rota+método confirmadas no resultado, batendo com os 9 módulos de rotas
  reais.
- **`docs/ARQUITETURA.md`** — os 4 processos (API + 3 workers), fluxo completo de um
  evento (device → Pub/Sub → `eventos_brutos` → handler → alerta), as 13 tabelas, por
  que a fila de escrita de política é serializada (rate limit da AMAPI é por projeto,
  não por device), motor de alertas reativo vs. periódico.
- **`docs/OPERACAO.md`** — achado real durante a escrita: o `docker-compose.yml` só
  define o serviço `api`, não existe deploy definido pros 3 workers em produção;
  documentado como lacuna conhecida, não resolvido silenciosamente. Também documentada
  uma restrição operacional crítica não óbvia no código: o worker de escrita de política
  só pode ter 1 réplica (2 instâncias quebram a garantia de serialização, cada uma com
  seu próprio `concurrency: 1`); o worker de manutenção também só 1 (senão dobra scan
  periódico/purga); só API e worker de Pub/Sub podem escalar.
- **`docs/LGPD.md`** — inventário completo de dado pessoal por tabela (titulares:
  colaboradores donos de device + usuários do painel), o que o sistema explicitamente
  NÃO coleta (localização contínua, senha de `RESET_PASSWORD`), retenção (só
  `eventos_brutos` tem purga automática hoje), e uma lista de pendências marcadas
  explicitamente como decisão jurídica, não técnica (base legal de cada tratamento,
  política de retenção pra `colaboradores`/`dispositivos`, processo formal de direito do
  titular).
- **`docs/APRESENTACAO-GERENCIA.md`** — resumo não-técnico pra gerência do Grupo Roveri:
  o que já funciona, o que esta fase entrega, e as 3 pendências que só a empresa
  consegue resolver (confirmação da enterprise AMAPI, tópico/subscription Pub/Sub, lista
  de filiais) — deixado explícito que nenhuma delas é atraso da equipe técnica.
- **`docs/HANDOFF-FRONTEND.md`** — fluxo de autenticação completo passo a passo (login
  via OIDC → cookie httpOnly → `POST /auth/refresh` → Bearer token), formato de erro RFC
  9457, padrão de paginação por cursor (`itens`/`proximoCursor`), os 4 papéis e o que
  cada um vê, fluxos principais (dashboard, lista de devices, emissão de comando com
  atenção a `WIPE`, políticas com latência da fila). Achado relevante: **não existe
  nenhuma rota HTTP pra criar token de enrollment** (processo de "adicionar device
  novo") — só existe como função interna, gap já registrado em `docs/SETUP.md` mas que
  precisava ficar explícito pro time de frontend não assumir que a rota existe.
- `README.md` atualizado (estado atual = Fase 7, lista de documentos de handoff com
  links).

**Arquivos criados:** `scripts/gerar-openapi.ts`; `docs/{openapi.json,ARQUITETURA,
OPERACAO,LGPD,APRESENTACAO-GERENCIA,HANDOFF-FRONTEND}.md`.

**Arquivos alterados:** `package.json` (script `docs:openapi`), `README.md`, este
arquivo.

**Arquivos removidos:** nenhum (o `.env`/`docker-compose.override.yml`/edição temporária
de porta usados só pra gerar o `openapi.json` foram criados e desfeitos dentro da
própria sessão, nunca chegaram a ficar no repositório).

**Funcionalidades afetadas:** nenhuma — fase é só documentação, nenhuma rota/lógica de
domínio mudou.

**Impacto da alteração:** nenhum risco de regressão — nenhum arquivo de `src/` foi
tocado.

**Validação realizada:**

- `npm run typecheck`/`lint`/`build` — limpos (inclusive o script novo).
- `npm run format:check` — os 5 markdowns novos formatados com Prettier; os 3 avisos
  remanescentes (`docker-compose.yml`, `package.json`, `README.md`) confirmados
  pré-existentes via `git stash` (mesmo na árvore committada original, antes de
  qualquer edição desta sessão) — não são regressão desta fase.
- `openapi.json` inspecionado programaticamente (contagem de paths/métodos) em vez de
  só "rodou sem erro" — conferido que reflete os 9 módulos de rotas reais, não uma
  versão parcial.

**Problemas encontrados:** nenhum bug de código. Duas lacunas de produto/processo
encontradas e documentadas (não corrigidas, porque são decisão de negócio/infra, não
bug): ausência de rota de enrollment via API (já era conhecida, mas não estava no
handoff de frontend) e ausência de definição de deploy dos 3 workers em produção (nova,
documentada em `docs/OPERACAO.md`).

**Pendências futuras:** as 3 já arquivadas desde a Fase 4/5 (enterprise AMAPI real,
tópico/subscription Pub/Sub, lista de filiais) — nenhuma delas bloqueia o que a Fase 7
entrega, só bloqueiam teste E2E real. Novas, registradas dentro dos próprios documentos
desta fase (não pendência de código): base legal/retenção/processo de titular (LGPD),
definição de deploy dos workers (OPERACAO), rota de enrollment (HANDOFF-FRONTEND).

---

### 2026-10-14 — Camada de automação (CI/CD, segurança, exportação Excel)

**Solicitação original:** depois da Fase 7, o Victor pediu pra automatizar o máximo
possível do processo — contexto explícito: este projeto vai se tornar um produto real
da empresa, e ele quer usar isso pra demonstrar maturidade técnica pra coordenadores/
gerentes. Pediu explicação detalhada de cada passo (primeira vez com esse tipo de
projeto).

**Status:** Concluída.

**O que foi realizado:**

- **CI** (`.github/workflows/ci.yml`) — 3 jobs paralelos a cada push/PR na main:
  qualidade (lint/format/typecheck/build), suíte de testes completa (Testcontainers,
  roda no runner `ubuntu-latest` sem configuração extra), e um job dedicado que
  regenera `docs/openapi.json` e falha se divergir do committed — nunca mais fica
  desatualizado em silêncio.
- **Pre-commit hooks** (husky + lint-staged) — testado de verdade (`npx lint-staged`
  contra arquivo staged real). Deliberadamente NÃO roda a suíte de testes no hook (ela
  sobe Testcontainers, levaria minutos) — só lint/format nos arquivos alterados.
- **Dependabot** (`.github/dependabot.yml`) — PRs semanais, agrupados por tipo
  (produção/dev, patch/minor juntos; major sempre separado).
- **CodeQL** (`.github/workflows/codeql.yml`) — varredura semanal + a cada push/PR,
  complementar ao `npm audit` (olha padrão de bug no NOSSO código, não só CVE de
  dependência).
- **`npm audit`**: 26 vulnerabilidades encontradas ao instalar husky/lint-staged. Corrigi
  as 6 sem breaking change (`npm audit fix`, sem `--force`) — caiu pra 20 (depois 21 com
  o `exceljs`, mesma cadeia de `uuid`/`dockerode` já existente, não uma vulnerabilidade
  nova). As restantes exigem upgrade de versão maior (**`drizzle-orm` tem uma falha real
  de SQL injection, corrigida só na 0.45.4** — a mais séria) — deliberadamente NÃO
  forçadas nesta sessão (upgrade de ORM pode mudar comportamento sutil, merece suíte
  completa rodada depois, não no meio de outra tarefa). Registrado como próxima tarefa
  dedicada.
- **`GET /dashboard/export`** — exportação do dashboard em `.xlsx` (biblioteca
  `exceljs`), aditivo ao `GET /dashboard` JSON existente (nunca um substituto). Mesmo
  RBAC. Teste de integração novo faz round-trip real: carrega o `.xlsx` retornado e
  confere o número contra o `/dashboard` JSON, não só status code/headers.
- **`render.yaml`** — infraestrutura-como-código pro deploy real do backend (API + 3
  workers) no Render, com a restrição de réplica de `docs/OPERACAO.md` documentada
  inline em cada worker. **Achado importante durante esta conversa:** o Victor queria
  Vercel pra tudo, mas Vercel não serve pra processo de vida longa (os 3 workers,
  principalmente o consumer Pub/Sub, que mantém uma subscription pull aberta o tempo
  todo) — sinalizado antes de implementar, decisão final: Vercel fica só com o
  frontend (futuro, domínio principal da empresa), backend vai pro Render (subdomínio
  `api.`). `docs/OPERACAO.md` atualizado com essa decisão e o motivo técnico.
- Suíte completa revalidada no final: 28 arquivos, **283 testes, todos passando**
  (195s). Um `ECONNRESET` no stderr durante teardown de uma conexão BullMQ — ruído
  benigno de fechamento de conexão, não falha (confirmado pelo exit code 0 e teste
  correspondente passando).
- **Commits separados por tema** (pedido explícito do Victor, "como o projeto já faz"):
  4 commits — Fase 7 (docs), CI/hooks/segurança, feature Excel, deploy Render. Exigiu
  reconstruir estados intermediários de arquivos tocados por mais de um tema
  (`package.json`/`package-lock.json` via uninstall/reinstall real de pacotes,
  `docs/OPERACAO.md`/`HANDOFF-FRONTEND.md`/`PROJECT_MEMORY.md` via reversão e
  reaplicação manual dos trechos) — cada commit intermediário foi revalidado
  (typecheck/lint/build) isoladamente antes de ser criado, não só o estado final.

**Arquivos criados:** `.github/workflows/{ci,codeql}.yml`; `.github/dependabot.yml`;
`.husky/pre-commit`; `render.yaml`; `src/domain/dashboard/exportar-excel.ts`.

**Arquivos alterados:** `package.json` (scripts `prepare`/lint-staged config,
dependências `husky`/`lint-staged`/`exceljs`), `package-lock.json`,
`src/modules/dashboard/dashboard.routes.ts` (rota `/dashboard/export`),
`test/integration/alertas-dashboard-routes.test.ts` (testes da rota nova),
`docs/api/dashboard.md`, `docs/HANDOFF-FRONTEND.md`, `docs/OPERACAO.md`, `README.md`,
este arquivo.

**Arquivos removidos:** nenhum.

**Funcionalidades afetadas:** nenhuma rota existente mudou comportamento — só adição
(`/dashboard/export` é rota nova) e atualização de dependências sem breaking change.

**Impacto da alteração:** nenhuma regressão — suíte completa revalidada no final, não
só o arquivo tocado.

**Validação realizada:**

- `npm run typecheck`/`lint`/`build`/`format:check` — limpos. Um atrito de tipagem real
  encontrado e documentado: `node_modules/exceljs/index.d.ts` declara globalmente
  `interface Buffer extends ArrayBuffer {}`, contaminando o tipo `Buffer` do projeto
  inteiro com um shape contraditório (bug conhecido da biblioteca) — resolvido com
  `@ts-expect-error` pontual e documentado no teste, não com um cast que não
  resolveria o problema de verdade.
- `npm test` completo — 283/283 passando.
- Teste do hook de pre-commit rodado de propósito contra um arquivo staged real antes
  de considerar "feito".
- Cada um dos 4 commits temáticos revalidado isoladamente (typecheck/lint/build) antes
  de ser criado — não só o diff final.
- `openapi.json`/CI/Dependabot/CodeQL/`render.yaml` **não foram testados contra uma
  conta GitHub Actions/Render real** — são configuração que só se valida de fato no
  primeiro push/PR real e no primeiro deploy real, respectivamente. Avisado
  explicitamente ao Victor, principalmente no `render.yaml` (sintaxe de alguns campos
  pode ter mudado desde que foi escrito).

**Problemas encontrados:** nenhum bug de lógica de negócio. Um atrito de tipagem de
terceiro (exceljs, ver acima) e uma vulnerabilidade real de segurança pré-existente
encontrada (SQL injection no `drizzle-orm` < 0.45.4) — nenhuma introduzida por este
trabalho, ambas documentadas, não ambas corrigidas (a segunda é pendência deliberada).

**Pendências futuras:**

1. **Upgrade de dependências com breaking change** — principalmente `drizzle-orm`
   (SQL injection real), também `vitest`/`drizzle-kit`/`@fastify/swagger-ui`/
   `testcontainers`. Requer rodar a suíte completa depois de cada upgrade, não em lote.
2. **Validar `render.yaml` contra uma conta Render real** antes do primeiro deploy —
   nunca foi testado contra a API real da plataforma.
3. **Preencher os segredos marcados `sync: false`** no Render (OIDC, AMAPI, etc.) e
   subir o JSON da service account como Secret File — nenhum deles pode ir no
   `render.yaml` em texto plano.
4. Pendências já listadas nas entradas anteriores (enterprise AMAPI real, Pub/Sub,
   filiais, construção do frontend) continuam de pé, inalteradas.

---

### 2026-10-15 — Primeiro push real e diagnóstico pós-GitHub

**Solicitação original:** Victor pediu push pro GitHub ("de forma limpa e segura,
automaticamente") e, depois, pra verificar se algo falhou no CI/CodeQL e corrigir
automaticamente — pergunta final: isso já permite considerar o backend 100% pronto pro
frontend.

**Status:** Concluída.

**O que foi descoberto:** o repositório remoto estava **vazio** desde a Fase 1
(clonado vazio, nunca recebeu push em nenhuma fase anterior) — `git branch
--unset-upstream` e "upstream is gone" eram sintoma disso, não de divergência. Primeiro
`git push -u origin main` enviou todo o histórico de uma vez (10 commits).

Sem `gh` CLI instalado — diagnóstico do Actions feito via API do GitHub direto
(`git credential fill` pra extrair o token já configurado, nunca impresso em log/saída).
3 falhas reais na primeira execução do CI/CodeQL contra a infraestrutura de verdade
(nenhuma reproduzível localmente, por isso não apareceram antes):

1. `npm run docs:openapi` usa `tsx --env-file=.env` — Node exige que o arquivo exista
   mesmo com as variáveis já injetadas via `env:` do workflow (`node: .env: not found`).
   Corrigido com `touch .env` antes do passo no CI.
2. `npm run lint` (regras type-aware do `typescript-eslint`, `parserOptions.project`)
   estourou o heap default do V8 no runner padrão (`JavaScript heap out of memory`) —
   na máquina local funciona porque o Node ajusta o heap pela RAM disponível, no runner
   não. Corrigido com `NODE_OPTIONS=--max-old-space-size=4096` no passo.
3. CodeQL falhava com "Code scanning is not enabled for this repository" — o
   repositório é **privado**, e essa integração nativa (aba Security) depende de uma
   configuração nas Settings do GitHub que pode exigir plano pago; não é decisão
   técnica pra tomar sozinho. Workaround aplicado: `upload: false` no
   `codeql-action/analyze` + `actions/upload-artifact`, mantendo a análise rodando sem
   depender dessa feature — documentado como pendência de decisão do Victor (habilitar
   ou não depois, conferindo o custo nas próprias Settings do repositório).

Depois de corrigir os 3, uma 4ª falha real apareceu (não um bug de infraestrutura, o
job `openapi-sincronizado` funcionando exatamente como projetado): `docs/openapi.json`
estava desatualizado de verdade — o commit da feature Excel (`89e6036`) adicionou
`GET /dashboard/export` mas ninguém rodou `npm run docs:openapi` de novo antes de
commitar. Regenerado e commitado separadamente.

**Status final confirmado contra o GitHub real** (não assumido): CI e CodeQL
`conclusion=success` no commit `b5ed2b3` (consultado via API até `status=completed` nos
dois, não só "deu push e assumi que passou").

**Arquivos alterados:** `.github/workflows/ci.yml` (fix `.env`/heap), `.github/workflows/codeql.yml`
(workaround de upload), `docs/openapi.json` (regenerado), este arquivo. 3 commits
(`da6c953`, `b5ed2b3`, e este) além do push inicial.

**Decisões técnicas tomadas:** workaround do CodeQL (`upload: false` em vez de exigir
"Code scanning" habilitado) — decisão técnica reversível a qualquer momento; não decide
pelo Victor se vale habilitar a feature paga/nativa.

**Pendências futuras:**

1. **Habilitar "Code scanning" nas Settings do repositório** (opcional, decisão do
   Victor) — conferir custo real pra repositório privado antes; sem isso, resultado do
   CodeQL só fica disponível como artefato do workflow, não na aba Security.
2. **7 PRs do Dependabot já abertos** (consequência esperada de ativar o
   `dependabot.yml`) — nenhum urgente, cada um passa pelo mesmo CI antes de poder ser
   mergeado; revisar quando conveniente.
3. Pendências já listadas nas entradas anteriores inalteradas (upgrade de
   `drizzle-orm`/breaking changes, validação do `render.yaml` contra conta real,
   enterprise AMAPI/Pub/Sub/filiais, construção do frontend).

**Resposta à pergunta do Victor ("posso considerar o backend 100%?"):** sim, do ponto
de vista de **qualidade de código e pipeline** — testado (283/283), com CI/CodeQL
verdes contra a infraestrutura real, não só localmente. **Não 100%** do ponto de vista
de **produto em produção**: as 3 pendências de negócio (enterprise AMAPI, Pub/Sub,
filiais) continuam bloqueando o primeiro teste E2E real contra um device físico — mas
nenhuma delas bloqueia começar o frontend, que consome a API já estável e documentada
(`docs/openapi.json`/`HANDOFF-FRONTEND.md`).

---

### 2026-10-15 — Upgrade do drizzle-orm (fecha a pendência de SQL injection)

**Solicitação original:** Victor pediu pra resolver a pendência deliberada do
`drizzle-orm` (vulnerabilidade real de SQL injection, documentada desde a Fase 7),
depois de uma sessão inteira completando as telas do frontend (comandos, políticas,
colaboradores/linhas, alertas, gestão de usuários).

**Status:** Concluída.

`drizzle-orm` `0.38.4` → `0.45.4` — corrige
[GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9) ("SQL
injection via identificador mal escapado", fixado na 0.45.2). `npm audit` confirma:
zero vulnerabilidades restantes pra `drizzle-orm`.

**Achado real durante o upgrade (não só por changelog — confirmado empiricamente
contra o Postgres de verdade antes E depois):** a partir da 0.44.0, todo erro vindo do
driver passa a vir embrulhado num `DrizzleQueryError` — o `PostgresError` original
(com o `.code` SQLSTATE que `errorHandler` usa pra decidir o 409 de "registro
duplicado") passa a viver em `.cause`, não mais direto no erro. Sem ajustar, a defesa
sistêmica contra violação de unicidade (`ehViolacaoDeUnicidade` em
`src/shared/problem-details.ts`) pararia de funcionar silenciosamente — toda
duplicata que escapasse do check prévio da rota cairia num 500 genérico em vez do 409
esperado, sem nenhum teste existente pra pegar isso (os testes de 409 das rotas
testam o check prévio explícito, não o catch-all do `errorHandler`).

Processo usado pra achar isso com confiança, não só confiar no changelog:

1. Script descartável inserindo a mesma matrícula duas vezes contra o Postgres real
   (`scripts/_check-erro-unicidade.ts`, nunca commitado) — rodado ANTES do upgrade
   pra confirmar a forma atual do erro (`PostgresError` direto, `.code` acessível).
2. `npm install drizzle-orm@0.45.4`.
3. Mesmo script de novo — confirmou a forma nova (`DrizzleQueryError`, `.code` só via
   `.cause.code`).
4. Corrigido `codigoPostgres()` em `problem-details.ts` pra olhar os dois níveis
   (funciona com ou sem o wrapper, não presume qual versão do driver está rodando).
5. Teste de regressão novo em `test/unit/problem-details.test.ts` cobrindo o formato
   embrulhado.

Nenhuma outra mudança de breaking change das versões 0.39–0.44 nos afeta: sem colunas
`array` (afetadas pela 0.41), sem uso de `.free()`/`.prepare(` manual, sem rotas MySQL
(a remoção de `.fullJoin()` da 0.43 é só MySQL). `db.query.politicas.findFirst` (RQB
v1, usado em 2 lugares) continua funcionando — a remoção do RQB v1 só acontece na
1.0.0-rc.1, bem além do alvo desta atualização.

**Status final confirmado:** typecheck limpo, lint limpo, suíte completa
**328/328** (327 + o teste novo), `docs/openapi.json` sem drift (nenhuma rota/schema
mudou, só o `errorHandler` interno).

**Decisão deliberada:** só o `drizzle-orm` foi atualizado nesta entrada.
`drizzle-kit` (dev-only, fix disponível na 0.31.11) e as 3 vulnerabilidades
`critical` do `vitest`/`tinypool`/`@vitest/coverage-v8` (reportadas pelo mesmo
`npm audit`, mas pré-existentes e sem relação com o `drizzle-orm`) ficam de fora do
escopo desta sessão — nenhuma delas é a pendência que o Victor pediu pra resolver.

**Arquivos alterados:** `package.json`/`package-lock.json` (upgrade),
`src/shared/problem-details.ts` (fix do `.cause`), `test/unit/problem-details.test.ts`
(teste de regressão), este arquivo.

**Pendências futuras:**

1. `drizzle-kit` ainda em `0.30.6` (fix disponível, `0.31.11`, major) — avaliar
   separadamente, é dependência de dev (migrations/studio), não roda em produção.
2. Vulnerabilidades `critical` em `vitest`/`tinypool`/`@vitest/coverage-v8` —
   pré-existentes, não introduzidas por este upgrade, fora do escopo desta entrada.
3. Pendências já listadas nas entradas anteriores inalteradas (validação do
   `render.yaml` contra conta real, enterprise AMAPI/Pub/Sub/filiais, 7 PRs do
   Dependabot, decisão sobre Code Scanning nativo).
