# Decisões técnicas (ADRs)

Registro de toda decisão tomada fora do que a spec original definiu explicitamente, ou onde
a spec conflitava com uma limitação real de alguma peça da stack. Formato curto:
contexto, decisão, consequência.

---

## ADR-001 — Geração de UUID v7 na aplicação, não no Postgres

**Contexto:** a seção 6 pede PKs em UUID v7 (ordenável por tempo). PostgreSQL só ganhou a
função nativa `uuidv7()` na versão 18; estamos fixados em **PostgreSQL 16** (seção 4), que
não tem geração de UUID v7 no servidor.

**Decisão:** gerar o UUID v7 na aplicação, via lib `uuidv7`, usando `$defaultFn()` do Drizzle
em cada coluna de PK — não `DEFAULT` em SQL na migration.

**Consequência:** inserts feitos fora da aplicação (ex.: script manual, seed via `psql`)
precisam gerar o UUID manualmente; a coluna não tem um default no banco pra cobrir esse caso.
Se algum dia migrarmos pra PG 18+, dá pra trocar por `uuidv7()` nativo sem mudar o tipo de
dado nem o shape das tabelas — só o `$defaultFn` sai do código.

---

## ADR-002 — Formatação de campos de duração da AMAPI é por campo, não genérica

**Contexto:** a seção 7 generaliza "campos de duração são string com sufixo (`'86400s'`)" e
cita `maximumTimeToLock` como exemplo. Na prática são dois formatos distintos na API: campos
do tipo `google.protobuf.Duration` (ex. `passwordExpirationTimeout`) usam string com sufixo
`s`; `maximumTimeToLock` é `int64` em milissegundos serializado como string, **sem** sufixo.

**Decisão:** `src/integrations/amapi/mappers.ts` (Fase 3) formata cada campo de duração
explicitamente pelo seu próprio formato, documentado no comentário ao lado do campo — nunca
um formatador genérico "todo duration leva `s`".

**Consequência:** mais verboso que um helper único, mas evita 400 silencioso da AMAPI por
formato errado. Revalidar contra a referência REST da AMAPI antes de fechar a Fase 3, campo
a campo, já que a doc do Google muda com o tempo.

---

## ADR-003 — Validação de domínio de e-mail é abstraída por provedor OIDC

**Contexto:** a seção 5 pede restringir o login por domínio corporativo validando a claim
`hd` (Google) ou `tid` (Entra) contra `ALLOWED_EMAIL_DOMAINS`. Isso não funciona igual pros
dois provedores: `hd` no Google É o domínio (`gruporoveri.com.br`); `tid` no Entra é o GUID
do tenant, não um domínio — comparar os dois contra a mesma lista de strings de domínio só
funciona pro Google.

**Decisão:** introduzir uma abstração `OidcDomainValidator` (uma implementação por provedor,
escolhida por `OIDC_ISSUER`). A implementação Google compara `hd`; a implementação Entra
compara o domínio extraído do claim `email`/`upn` (ou do tenant via Microsoft Graph, se
precisarmos de garantia mais forte que o e-mail).

**Consequência:** trocar de provedor continua exigindo só variáveis de ambiente (`OIDC_*`),
mas o código de validação de domínio precisa saber qual provedor está ativo — não é 100%
"agnóstico" no sentido de zero `if` por provedor, só na configuração.

---

## ADR-004 — Papel `AUDITOR` não acessa nenhuma rota `/devices/*`

**Contexto:** a seção 5 diz que `AUDITOR` "não vê inventário operacional nem executa ação",
mas a seção 10 lista `GET /devices/:id/auditoria` sem excluir explicitamente esse papel.

**Decisão (confirmada com o Victor em 2026-09-04):** `AUDITOR` só acessa `GET /auditoria`
(visão global, filtrável por `entidade=dispositivo&entidade_id=...` quando precisar do
histórico de um device específico). Nenhuma rota sob `/devices/*` aceita o papel `AUDITOR`,
nem as de leitura.

**Consequência:** o teste "toda rota rejeita todo papel não autorizado" (seção 5) trata
`/devices/:id/auditoria` como não-autorizado para `AUDITOR`, mesmo sendo uma rota de leitura
de auditoria.

---

## ADR-005 — Domínio de e-mail corporativo e enterprise AMAPI

**Contexto:** seção 15 pedia esses valores antes de começar.

**Decisão:**

- `ALLOWED_EMAIL_DOMAINS=gruporoveri.com.br` (confirmado).
- `AMAPI_ENTERPRISE_NAME` fica com placeholder (`enterprises/LC00000000000000000`) até a
  empresa confirmar o valor real do binding já feito (seção 2). **Bloqueia o teste real de
  ponta a ponta contra a AMAPI** (a Fase 3 em diante roda contra fixtures/mocks até lá).
- Tópico/subscription do Pub/Sub, lista de filiais e critério final de "operadora" (seção 6
  trata como texto livre por decisão do Victor, não enum fechado) ficam em aberto — Pub/Sub
  e filiais dependem de conversa com a equipe de frontend/infra ainda não realizada.
- `ANDROID_VERSAO_MINIMA_SDK` (usado no alerta `SO_OBSOLETO`, Fase 6) fica com default
  conservador (SDK 30 / Android 11) até a empresa confirmar a frota atual.

**Consequência:** nenhuma dessas pendências bloqueia a Fase 1. Bloqueiam, na ordem: o teste
E2E real da Fase 3 (enterprise), o handler `ENROLLMENT` da Fase 4 (Pub/Sub) e o seed de
filiais da Fase 6.

---

## ADR-006 — `NODE_ENV` do serviço `api` é fixado em `production` no `docker-compose.yml`

**Contexto:** achado na validação da Fase 1 (`docker compose up --build`). O `.env` local
(copiado de `.env.example`) traz `NODE_ENV=development` por padrão — correto para quem roda
`npm run dev` fora de container. O `env_file: .env` do serviço `api` propagava esse valor pra
dentro do container, mas a imagem do container é a de **produção** (Dockerfile, stage
`runtime`, `npm ci --omit=dev`). Em `NODE_ENV=development`, `src/shared/logger.ts` tenta
carregar o transport `pino-pretty` — que é devDependency de propósito, pra não inflar a
imagem final. Resultado: o container morria no boot com
`Error: unable to determine transport target for "pino-pretty"`.

**Decisão:** `docker-compose.yml` sobrescreve `NODE_ENV: production` explicitamente no
serviço `api`, depois do `env_file`, independente do que o `.env` local tiver.

**Consequência:** rodar `npm run dev` fora de container continua em modo development
(log bonito via pino-pretty); rodar via `docker compose up` (imagem de produção) sempre roda
em `production`, com log JSON puro — não há mais como o `.env` de dev vazar pra dentro do
container e escolher um transport que a imagem não tem instalado.

---

## ADR-007 — Enum de banco só para categorias que o nosso sistema origina, texto livre para o que é observado de fora

**Contexto:** a seção 6 não é explícita sobre quando usar `enum` do Postgres vs. `text` pros
campos categóricos do schema (`dispositivos.estado`, `dispositivo_apps.install_type`,
`eventos_brutos.notification_type`, `comandos.tipo`, `alertas.tipo`, `linhas.status`, etc.).

**Decisão:** enum de banco (`pgEnum`) só para valores que **o nosso próprio código decide e
transiciona** — `usuarios.role`, `linhas.status`, `comandos.tipo`/`status`,
`alertas.tipo`/`severidade`. Texto livre (`text`) para valores **reportados por um sistema
externo que não controlamos** — `dispositivos.estado`/`compliance_state`,
`dispositivo_apps.install_type`/`estado`, `eventos_brutos.notification_type` — porque esses
espelham enums da própria AMAPI/Pub/Sub, que pode adicionar um valor novo do lado deles a
qualquer momento; se fosse enum nosso, um INSERT/UPDATE com um valor legítimo mas novo da
AMAPI quebraria até sairmos uma migration pra acrescentar o valor no nosso enum.

**Consequência:** um valor absurdo em campo "nosso" (ex.: `comandos.tipo = 'ALGO_ESTRANHO'`)
é pego pelo Postgres na hora do INSERT. Um valor novo em campo "observado" não quebra o
INSERT — mas também não tem validação de schema nenhuma; a validação desses campos, quando
fizer sentido, é responsabilidade do mapper da AMAPI (`src/integrations/amapi/mappers.ts`,
Fase 3/4), não do banco.

---

## ADR-008 — Append-only de `auditoria` é garantido por trigger, não pelo `REVOKE` da seção 6

**Contexto:** a seção 6 pede literalmente `REVOKE UPDATE, DELETE` para "o usuário da
aplicação". Implementei isso ao pé da letra na migration `0001` (`REVOKE ... FROM
CURRENT_USER`) e **testei contra um Postgres 16 real antes de considerar a fase concluída**:
INSERT com role `app`, depois UPDATE e DELETE na mesma linha. Os dois passaram — mesmo com a
ACL (`\dp auditoria`) confirmando que os privilégios de fato tinham sido revogados (`app` sem
`w`/`d` na lista de permissões).

**Causa raiz:** este projeto usa **uma única role de banco para tudo** — `app` (via
`DATABASE_URL`) tanto roda as migrations (e por isso é _dona_ das tabelas) quanto atende as
queries da aplicação em runtime. No Postgres, o dono de uma tabela retém acesso implícito às
operações básicas (SELECT/INSERT/UPDATE/DELETE) independente do que for revogado dele via
GRANT/REVOKE — `REVOKE` só é eficaz contra uma role que **não** é dona do objeto. A spec
pressupõe implicitamente uma role de aplicação distinta da role dona/migradora, que não existe
neste projeto (nenhuma seção da spec pede duas roles de banco).

**Decisão:** a migration `0001` mantém o `REVOKE` (inofensivo, e correto no dia em que o
projeto separar role de app e role de migração — não coberto por esta fase) e adiciona um
**trigger** `BEFORE UPDATE OR DELETE ON auditoria` que sempre lança exceção
(`auditoria_bloquear_update_delete()`). Trigger funciona independente de ownership — é o que
efetivamente impede a alteração/remoção de linhas, testado e confirmado.

**Consequência:** um `ALTER TABLE`/DDL futuro na `auditoria` continua permitido (dono da
tabela sempre pode, é direito inerente à posse, não passa por ACL nem por trigger de DML) —
só INSERT/SELECT continuam liberados e UPDATE/DELETE ficam bloqueados de verdade, pra
qualquer role, inclusive uma futura role de app sem ownership nenhum.

---

## ADR-009 — Imports relativos usam extensão `.ts`, não `.js`

**Contexto:** o projeto roda em ESM puro sob `moduleResolution: NodeNext`, que exige extensão
explícita em todo import relativo — e o runtime real (`node dist/server.js`) precisa que essa
extensão seja `.js` (o arquivo compilado). Só que `drizzle-kit` (usado desde a Fase 2 pros
schemas) carrega os arquivos de schema via `esbuild-register`, um hook de `require()` do
Node — que resolve o especificador **literalmente**: `require('./usuarios.js')` falha com
`MODULE_NOT_FOUND` porque o arquivo em disco é `usuarios.ts`, e um `require()` com extensão
explícita não faz fallback de extensão (diferente de um `require('./usuarios')` sem
extensão, que tenta `.ts`/`.js`/`.json` em sequência). Ou seja: `.js` funciona no runtime da
aplicação e quebra no `drizzle-kit`; `.ts` funcionaria no `drizzle-kit` mas por padrão o `tsc`
recusa compilar (`moduleResolution: NodeNext` exige que o import bata com o nome do arquivo
COMPILADO, não do fonte).

**Decisão:** todo import relativo no projeto (não só `src/db/schema/`) usa extensão `.ts`
(`from './foo.ts'`), com duas flags novas em `tsconfig.json`:
`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`. A segunda (TypeScript
5.7+) reescreve `.ts` → `.js` nos imports do JavaScript emitido — confirmado no
`dist/` compilado (`export * from "./usuarios.js"`). Resultado: o fonte usa `.ts` (resolve
certo no `require()` literal do `esbuild-register`), o `dist/` usa `.js` (resolve certo no
`node` ESM em runtime). As duas ferramentas ficam satisfeitas com o mesmo código-fonte, sem
duplicar arquivo nenhum.

**Consequência:** todo `import`/`export * from` relativo novo no projeto segue esse padrão —
`.ts`, nunca `.js`. Exceção deliberada: **imports dinâmicos** (`await import('./foo.js')`,
usados em teste pra adiar a resolução do módulo — ver `test/integration/health.test.ts`)
continuam com `.js`, porque `rewriteRelativeImportExtensions` só reescreve especificadores de
`import`/`export` estáticos, não strings passadas pra `import()` em runtime; e o Vitest
resolve esses dinamicamente via Vite, não pelo `tsc` nem pelo `esbuild-register` do
drizzle-kit, então o problema que motivou esta decisão não se aplica a eles.

---

## ADR-010 — Contrato de `/auth/callback`: state stateless, refresh via cookie httpOnly, sem access token na URL

**Contexto:** a seção 10 lista `GET /auth/callback` sem detalhar o contrato de resposta —
mas essa rota é inerentemente voltada pro browser (é o próprio Google/Entra redirecionando
o usuário de volta), então alguma decisão de UX/segurança é inevitável, e ela afeta
diretamente o que o time de frontend precisa construir.

**Decisões:**

1. **`code_verifier` (PKCE) e `nonce` viajam dentro do próprio parâmetro `state`**, como um
   JWT curto (10 min) assinado com `JWT_SECRET` (`src/domain/auth/oidc-state.ts`). Não há
   sessão de servidor nem cookie de state antes do login — a API não guarda nada entre
   `/auth/login` e `/auth/callback` além do que o próprio provedor devolve no round-trip do
   `state`. Evita precisar de Redis/store só pra 10 minutos de vida de um fluxo de login.
2. **O refresh token vai num cookie `httpOnly`, `Secure` em produção, `SameSite=Lax`,
   `path=/auth`** — nunca acessível a JavaScript do frontend. Rotacionado a cada uso
   (`POST /auth/refresh`), igual ao cookie.
3. **O access token (JWT de 15 min) nunca trafega pela URL do redirect.** `/auth/callback`
   termina redirecionando pra `FRONTEND_URL` só com o cookie de refresh já setado; o
   frontend chama `POST /auth/refresh` assim que a página carrega (o cookie já vai junto)
   pra obter o primeiro access token. URL/histórico do browser não é lugar seguro pra token
   nenhum, por mais curto que seja.
4. **Redirect de erro:** qualquer falha no callback (state inválido, domínio não permitido,
   troca de code por token falhou, usuário inativo, provedor recusou) redireciona pra
   `FRONTEND_URL?erro_login=<motivo>` em vez de devolver JSON cru — é o browser do usuário
   vendo essa resposta, não uma chamada de API programática.
5. **Não há `redirect_to` configurável por request** — o destino pós-login é sempre
   `FRONTEND_URL` fixo. Aceitar um destino arbitrário vindo do cliente em `/auth/login` e
   propagá-lo até o redirect final é a receita clássica de um _open redirect_; não
   implementado até existir uma lista de destinos permitidos pra validar contra.

**Consequência:** isso é o contrato que `docs/HANDOFF-FRONTEND.md` (Fase 7) vai documentar
formalmente pro time de frontend. Registrado aqui desde já porque muda o que eles precisam
construir (ler `erro_login` na query string, chamar `/auth/refresh` no boot da SPA, nunca
tentar ler o refresh token via JS).

---

## ADR-011 — Endpoints de gestão de usuário/role (gap da seção 10)

**Contexto:** a seção 5 exige "elevação de role é manual, feita por um ADMIN" e a tabela de
RBAC diz que `ADMIN` "gerencia usuários e roles" — mas a seção 10 (superfície completa da
API) não lista nenhuma rota de usuários. Sem endpoint, essa exigência da seção 5 é
inatingível: ninguém jamais sairia de `VIEWER`.

**Decisão:** adicionados `GET /usuarios` (lista, role `ADMIN`) e `PATCH /usuarios/:id`
(altera só o campo `role`, role `ADMIN`), ambos em `src/modules/auth/auth.routes.ts` junto
das rotas de auth (não há um módulo `usuarios` de domínio separado ainda — o repositório em
`src/domain/usuarios/repositorio.ts` existe, mas as rotas HTTP de colaboradores/CRUD de
usuário completo não são pedidas em nenhuma fase; só o necessário pra RBAC funcionar).

**Não implementado, por decisão de escopo mínimo (não por esquecimento):** proteção contra
remover o último `ADMIN` do sistema (auto-rebaixamento ou rebaixamento do único admin
restante deixaria o sistema sem ninguém capaz de gerenciar roles). É uma salvaguarda real,
mas não pedida — registrada aqui como pendência pra decisão explícita do Victor antes da
Fase 7, não implementada em silêncio.

**Consequência:** `docs/HANDOFF-FRONTEND.md` (Fase 7) precisa documentar essas duas rotas
mesmo não estando na seção 10 original — senão o frontend não saberia que elas existem.

---

## ADR-012 — Bootstrap do primeiro ADMIN via `BOOTSTRAP_ADMIN_EMAILS`

**Contexto:** provisionamento JIT (seção 5) sempre cria `usuarios.role = VIEWER`. Elevação de
role é manual, via `PATCH /usuarios/:id`, que só um `ADMIN` pode chamar. Sem um ADMIN
pré-existente, esse ciclo nunca começa.

**Decisão:** env var `BOOTSTRAP_ADMIN_EMAILS` (lista separada por vírgula, opcional — default
vazio). No provisionamento JIT (`provisionarUsuario`, `src/domain/usuarios/repositorio.ts`),
se o e-mail do usuário estiver nessa lista, a role já nasce `ADMIN` em vez de `VIEWER`.
Depois do setup inicial, promoção de role passa a ser sempre via `PATCH /usuarios/:id` — a
env var não dá privilégio contínuo, só afeta o momento do primeiro provisionamento daquele
e-mail específico.

**Consequência:** recomendação operacional (`docs/SETUP.md`): configurar
`BOOTSTRAP_ADMIN_EMAILS` só com o(s) e-mail(s) de quem vai fazer o setup inicial, e
considerar limpar a variável (ou deixá-la, já que só afeta _primeiro_ provisionamento —
reprovisionar não existe, um usuário já criado não é afetado por mudanças nela depois)
após o primeiro ADMIN real existir no sistema.

---

## ADR-013 — Duas pendências da Fase 2 resolvidas: último ADMIN e reuso de refresh token

**Contexto:** o ADR-011 registrou como pendência "proteção contra remover o último ADMIN" e o
`PROJECT_MEMORY.md` registrou como pendência "revogação em cascata no reuso de refresh
token" — ambas descritas como fora de escopo da Fase 2 por decisão deliberada. Pedido do
Victor: resolver essas duas de forma cirúrgica e prática, sem esperar a Fase 7.

**Decisão 1 — último ADMIN:** `PATCH /usuarios/:id` agora recusa (422) rebaixar um usuário
`ADMIN` quando ele é o único ADMIN ativo no sistema (`contarAdminsAtivos()` em
`src/domain/usuarios/repositorio.ts`). Sem transação/lock — é uma checagem simples antes do
`UPDATE`, proporcional a um painel administrativo de baixo tráfego; uma corrida entre dois
rebaixamentos simultâneos do "último" ADMIN é um cenário extremo não coberto.

**Decisão 2 — reuso de refresh token:** `rotacionarRefreshToken` (`src/domain/auth/refresh-tokens.ts`)
agora distingue três casos ao invés de tratar tudo como "token inválido": token nunca existiu
(401 simples), token só **expirou** normalmente (401 simples, sem cascata — não é sinal de
nada suspeito) e token **já foi revogado/rotacionado antes** — esse último caso revoga
**todos** os refresh tokens ativos daquele usuário na mesma transação, derrubando qualquer
sessão em andamento, inclusive a legítima. Mais simples que rastrear uma "família" de tokens
por dispositivo/sessão (exigiria coluna nova no schema), mas fecha o cenário real de abuso
que motivou a pendência.

**Consequência:** as duas linhas correspondentes na tabela de pendências do
`PROJECT_MEMORY.md` saem de "pendente" pra "resolvida nesta entrada". Testado em
`test/integration/rbac.test.ts` (último ADMIN) e `test/integration/refresh-tokens.test.ts`
(cascata).

---

## ADR-014 — Porta padrão de desenvolvimento é 13000, não 3000

**Contexto:** a porta 3000 (host) da máquina de desenvolvimento do Victor está ocupada por
um processo `node.exe` alheio a este projeto (não iniciado por nenhuma sessão de trabalho
aqui) — `docker compose up`/`npm run dev` falhavam ao tentar abrir essa porta.

**Decisão:** `PORT=13000` é o novo default em `.env.example` (e, por consequência,
`ALLOWED_ORIGINS`/`OIDC_REDIRECT_URI` de exemplo, `docker-compose.yml` e o `EXPOSE`/
`HEALTHCHECK` do `Dockerfile`). Não é uma limitação do projeto — qualquer um pode continuar
usando `3000` (ou outra porta) sobrescrevendo `PORT` no próprio `.env`; só o valor de exemplo
versionado mudou, pra funcionar de primeira nesta máquina sem exigir ajuste manual.

**Consequência:** documentação (`README.md`, `docs/SETUP.md`) atualizada pra usar `:13000`
em todos os exemplos de `curl`/URL. Nada no código lê a porta como valor fixo — tudo vem de
`env.PORT`, então a mudança é só de configuração/documentação.

---

## ADR-015 — `uninstallBlocked` não existe no schema atual da AMAPI; `uninstallAppsDisabled` é o mecanismo real

**Contexto:** a seção 3 exige que "todo item de `policy.applications` receba
`uninstallBlocked: true`, sem exceção". Antes de implementar `enforceInvariants`, inspecionei
o `Schema$ApplicationPolicy` do cliente oficial `googleapis` (v178.0.0, gerado a partir do
discovery document do Google) — não existe campo `uninstallBlocked` ali. Confirmei contra a
[documentação REST oficial](https://developers.google.com/android/management/reference/rest/v1/enterprises.policies):
o mecanismo real é `Policy.uninstallAppsDisabled` (nível de política, não por app), que a
própria doc do Google descreve como "_prevents apps from being uninstalled, even those
removed using `applications`_" — ou seja, sozinho já cobre TODOS os apps, sem precisar de
sinalização por item.

**Decisão (confirmada com o Victor em 2026-09-05):** `enforceInvariants`
(`src/domain/policy/policy-invariants.ts`) força **os dois**:

1. `uninstallAppsDisabled: true` no nível da política — o mecanismo real, sempre aplicado.
2. `uninstallBlocked: true` em cada item de `applications[]` — mantido por pedido explícito
   do Victor, como campo defensivo. Como o campo não existe no schema documentado, escrevê-lo
   hoje é um no-op inofensivo (a AMAPI ignora campos desconhecidos do JSON); a decisão é
   deliberada: se a AMAPI de produção da empresa algum dia expuser esse campo (versão
   diferente, campo em beta), o valor certo já está sendo enviado sem precisar de deploy.

**Consequência:** o teste de "tentativa de bypass" e "rollback de versão antiga" da seção 3
cobre os dois campos — `uninstallAppsDisabled` (o que garante a proteção de verdade) e
`uninstallBlocked` (defensivo). `installType` continua validado por app como a spec pede
(`FORCE_INSTALLED`/`AVAILABLE`/`PREINSTALLED` sempre permitidos; `BLOCKED` só se já vinha
`BLOCKED` no payload recebido — o invariante não decide sozinho o que bloquear). 100% de
cobertura em `policy-invariants.ts`, conferido com `npm run test:coverage`.

---

## ADR-016 — Valores em aberto no seed das políticas padrão

**Contexto:** a seção 7 pede duas políticas padrão (`administrativo`, `operacao-campo`)
cobrindo uma lista de campos, mas não diz os VALORES que diferenciam uma da outra, nem um
valor pra `maximumTimeToLock` (só cita o campo, não um número), nem quais apps cada perfil
deve ter.

**Decisões:**

1. **As duas políticas nascem com o payload IDÊNTICO** (só `nome`/`descricao` diferem) — a
   spec não pede nenhuma diferenciação de valores entre elas, e inventar uma (ex.: tempo de
   bloqueio de tela mais curto pra campo) seria decidir uma regra de negócio que ninguém
   pediu.
2. **`maximumTimeToLock: 60000` (1 minuto)** — não pedido explicitamente, escolhido como
   default conservador e comum em ambiente corporativo. Ajustável a qualquer momento via
   `PATCH /policies/:id` (Fase 5) sem precisar rodar o seed de novo.
3. **`applications: []` nas duas políticas** — a lista de apps de cada perfil (RH usa isso,
   campo usa aquilo) é uma decisão de negócio real que ninguém definiu ainda; inventar
   pacotes de app fictícios pra "preencher" seria pior que deixar vazio. `enforceInvariants`
   não quebra com lista vazia — só não tem nada pra aplicar o invariante ainda.

**Consequência:** o seed (`npm run db:seed`, `src/db/seed/politicas-padrao.ts`) é idempotente
(não duplica se a política já existe, por `nome`) e não empurra nada pra AMAPI — só popula a
tabela `politicas` local. O envio de verdade pra AMAPI acontece quando alguém editar/ativar a
política pela rota (Fase 5), passando por `enforceInvariants` de novo naquele momento.
**Pendência registrada:** lista de apps por perfil e eventual diferenciação entre os dois
perfis dependem de decisão do Victor/negócio antes do go-live (mesma natureza das pendências
de filiais/Pub/Sub do ADR-005).

---

## ADR-017 — Formato real das notificações Pub/Sub da AMAPI

**Contexto:** antes de escrever o consumer (seção 8), confirmei o formato real da mensagem
na [documentação oficial](https://developers.google.com/android/management/notifications) —
e ele é diferente do que a seção 8 dá a entender (que fala em ler "`notificationType`" sem
especificar onde).

**O que a doc do Google diz, literalmente:** _"The `attributes` field of the message
contains an attribute with key `notificationType`... The `data` field of the message
contains the JSON representation of the resource that was updated."_ Ou seja:

1. **`notificationType` vem de `message.attributes.notificationType`**, não de um campo
   dentro do JSON de `data`.
2. **`data` é o RECURSO cru**, não um envelope — `ENROLLMENT`/`STATUS_REPORT` →
   `Device`; `COMMAND` → `Operation`; `USAGE_LOGS` → `UsageLogEvent`. Não existe um campo
   comum tipo `{ notificationType, device: {...} }` — o próprio `data` JÁ é o `Device`.
3. **Existe um tipo a mais que a spec não lista:** `ENTERPRISE_UPGRADE`. Tratado como
   "notificationType desconhecido" (só grava em `eventos_brutos`, sem handler específico) —
   não é um requisito novo, é só a AMAPI podendo mandar mais tipos do que os 5 da seção 8.
4. **O valor da mensagem de teste é `test` (minúsculo)**, não `TEST` como a seção 8 escreve.

**Como o `ENROLLMENT` sabe qual `enrollment_token` foi usado:** a seção 7 diz que
`additionalData` "permite vincular automaticamente" mas não diz COMO — o campo
`Device.enrollmentTokenData` (confirmado no schema do `googleapis`) é exatamente o valor de
`additionalData` que setamos na criação do token. É dali que o handler de `ENROLLMENT` lê o
`tokenId` interno pra achar a linha certa em `enrollment_tokens`.

**Decisão:** `src/workers/pubsub-consumer.ts` lê `notificationType` de `message.attributes`,
trata `data` como o recurso puro (tipado por notificationType), aceita `test`/`TEST` como
sinônimos pro caso de teste, e loga (sem handler) qualquer tipo não mapeado, incluindo
`ENTERPRISE_UPGRADE`. `eventos_brutos.payload` grava `{ attributes, data }` juntos — fiel à
mensagem inteira, não só ao recurso — pra não perder informação nenhuma no replay.

**Consequência:** se essa doc mudar ou eu tiver lido errado, o sintoma seria bem visível —
`eventos_brutos.notification_type` viria `null`/vazio pra toda mensagem real. Vale conferir
de novo assim que houver um enrollment de verdade contra a AMAPI (bloqueado hoje pela
enterprise placeholder, ADR-005).

---

## ADR-018 — Coluna `dispositivos.ativo` (gap entre seção 6 e seção 10)

**Contexto:** a seção 10 é explícita — `PATCH /devices/:id` "vincula colaborador, linha,
patrimônio, **ativo**". A tabela `dispositivos` da seção 6 não lista nenhuma coluna `ativo`.
Mesmo padrão do ADR-011 (rota pedindo dado que o schema original não previu).

**Decisão:** adicionada `ativo boolean not null default true` em `dispositivos`
(`drizzle/migrations/0002_dispositivos_ativo.sql`), na Fase 4, quando a rota que
efetivamente precisa dela foi escrita — não antecipada sem uso na Fase 2.

**Consequência:** dispositivo recém-provisionado (handler `ENROLLMENT`) nasce `ativo: true`
por default. Desativar um dispositivo (ex.: extraviado, aguardando devolução) fica só como
sinalização — não desprovisiona nem revoga nada na AMAPI sozinho; isso continua exigindo uma
ação explícita (comando de wipe, Fase 5) ou o fluxo de desligamento (seção 10, Fase 6).

---

## ADR-019 — Mapeamento `Device` (AMAPI) → `dispositivos`/`dispositivo_apps`: 3 divergências

**Contexto:** ao escrever `mapearCamposDispositivo`/`mapearAppsDoDispositivo`
(`src/integrations/amapi/mappers.ts`) pro handler `STATUS_REPORT`, conferi o `Schema$Device`
real do `googleapis` campo a campo contra a seção 6 e achei três pontos sem correspondência
direta.

1. **Não existe `compliance_state` no `Device`** — só `policyCompliant` (boolean) e
   `nonComplianceDetails` (lista de motivos). **Decisão:** `complianceState` é derivado de
   `policyCompliant` (`true` → `'COMPLIANT'`, `false` → `'NON_COMPLIANT'`, ausente →
   `undefined`/desconhecido) em vez de copiado de um campo que não existe.
2. **Bateria e storage livre não são campos estáticos** — são o evento mais recente de
   `powerManagementEvents`/`memoryEvents` (arrays cronológicos). **Decisão:** pega o evento
   mais recente por `createTime`. Pro storage, o filtro usa "`eventType` contém STORAGE"
   (case-insensitive) em vez de comparar contra um literal exato do enum
   `MemoryEventType`, porque não consegui confirmar os valores exatos desse enum na
   documentação pública disponível. **Pendência:** validar contra um device real assim que
   houver um (bloqueado pela enterprise placeholder, ADR-005) — até lá, os alertas
   `STORAGE_CRITICO`/`BATERIA_DEGRADADA` (Fase 6) herdam essa incerteza.
3. **`ApplicationReport` não tem `installType`** — isso é atributo de POLÍTICA (o que
   queremos instalado), não do relatório do device (o que está instalado observado).
   **Decisão:** `dispositivo_apps.install_type` fica sem valor quando vem do
   `STATUS_REPORT` — não inventado. O alerta `APP_OBRIGATORIO_AUSENTE` compara a política
   contra `dispositivo_apps.package_name` diretamente, não contra essa coluna.

**Consequência:** nenhuma dessas três bloqueia o critério da Fase 4 (o enrollment popular o
banco sozinho) — todas afetam só a PRECISÃO de dados que só chegam via `STATUS_REPORT`,
processado depois do enrollment.

---

## ADR-020 — Índice único parcial pra alerta aberto, não check-then-insert

**Contexto:** o handler `STATUS_REPORT` (Fase 4) precisa abrir o alerta `APP_OBRIGATORIO_
AUSENTE` sem duplicar em `STATUS_REPORT`s consecutivos com o mesmo app faltando. A seção 6
não especifica o mecanismo de idempotência — um check-then-insert (`SELECT` seguido de
`INSERT` se não achou) tem uma janela de corrida real entre duas mensagens do mesmo device
processadas em paralelo.

**Decisão:** `alertas` ganhou um índice único PARCIAL —
`UNIQUE (dispositivo_id, tipo) WHERE resolvido_em IS NULL`
(`drizzle/migrations/0003_alertas_aberto_unico.sql`) — e `abrirAlertaSeNaoExistir`
(`src/domain/alertas/repositorio.ts`) usa `ON CONFLICT DO NOTHING` contra ele, não um
check-then-insert.

**Consequência:** um alerta ABERTO é único por dispositivo+tipo, garantido pelo próprio
Postgres, não pela ordem de chamadas da aplicação. Vários alertas RESOLVIDOS do mesmo tipo
pro mesmo device continuam permitidos (histórico esperado: o problema aconteceu, foi
corrigido, aconteceu de novo). `where` no `onConflictDoNothing` do Drizzle precisa casar
exatamente com o predicado do índice parcial — sem isso o Postgres rejeita o `ON CONFLICT`
em runtime ("no unique or exclusion constraint matching").

---

## ADR-021 — Suíte de testes serial (`fileParallelism: false`), não por threads limitadas

**Contexto:** a partir da Fase 4 a suíte passou a ter mais de 10 arquivos de integração
subindo Postgres/Redis via Testcontainers. O paralelismo TOTAL padrão do Vitest (todo arquivo
ao mesmo tempo) estourava o `hookTimeout` na criação dos containers, em ambiente de
desenvolvimento (Windows + Docker Desktop + WSL2). Tentei `poolOptions.threads.maxThreads: 3`
como meio-termo antes de chegar nesta decisão — **não resolveu**, e o diagnóstico foi direto
ao ponto: um `docker run postgres:16-alpine` isolado, rodado manualmente durante a mesma
janela de falhas, ficou pronto pra aceitar conexões em ~1 segundo. Ou seja, o gargalo não é
memória/CPU do container Postgres em si — é overhead da própria orquestração do
Testcontainers (criação de rede Docker, sessão do reaper Ryuk, port binding, polling de log)
quando várias instâncias disparam essas chamadas contra a API do Docker Desktop/WSL2 ao mesmo
tempo. Também foi identificada e removida uma causa concorrente real: dois containers de
OUTRO projeto (não deste repositório) rodando havia 45h consumindo parte da memória, já
limitada (~3.7GB), do Docker Desktop desta máquina — removê-los sozinho não foi suficiente,
confirmando que o gargalo principal é mesmo o overhead de orquestração concorrente, não RAM.

**Decisão:** `fileParallelism: false` (`vitest.config.ts`) — suíte de testes inteira roda em
sequência, um arquivo por vez. `hookTimeout` mantido em 90s como margem extra pro `beforeAll`
mais lento (subida de container + migrations).

**Consequência:** suíte local mais lenta no total (dezenas de minutos, não segundos) — troca
deliberada de velocidade por determinismo. Em CI (runners Linux hospedados, sem a camada
WSL2 e com uma API Docker nativa, não emulada) esse overhead de orquestração tende a ser bem
menor; se o tempo de CI incomodar, vale medir lá antes de reintroduzir paralelismo — não
assumir que o mesmo gargalo desta máquina Windows se repete.

---

## ADR-022 — Escrita de política síncrona do ponto de vista da rota (`QueueEvents`)

**Contexto:** a Fase 3 deixou a fila serializada (`src/queues/policy-write-queue.ts`,
concorrência 1) pronta como biblioteca, mas nada nunca a consumia de verdade — nem rota HTTP
enfileirava, nem worker processava. A Fase 5 precisa que `POST`/`PATCH /policies` respondam
com o resultado real da escrita (payload corrigido pela AMAPI, ou o erro dela) — enfileirar e
responder 202 "aceito" sem saber se deu certo obrigaria o frontend a ficar consultando um
status à parte, sem necessidade nenhuma pra um painel administrativo de baixo tráfego.

**Decisão:** `executarEscritaPoliticaSincrona` (`policy-write-queue.ts`) enfileira o job e usa
`QueueEvents`/`job.waitUntilFinished(...)` (BullMQ) pra aguardar o resultado antes da rota
responder — terceira conexão Redis dedicada, mesmo princípio de isolamento das outras duas
(producer/worker) já usadas na fila. Um worker dedicado novo,
`src/workers/policy-write-worker.ts` (`npm run worker:policy-write`), é quem de fato chama
`salvarPolitica` — a rota HTTP nunca chama o adapter AMAPI direto, só enfileira.

**Consequência:** a API HTTP agora depende de um processo worker de pé pra qualquer escrita de
política funcionar (documentado em `docs/SETUP.md`) — sem ele, `waitUntilFinished` expira
(timeout de 30s) e a rota devolve 502. Concorrência 1 continua garantida mesmo com múltiplos
processos de API atrás de um load balancer, porque todos enfileiram na mesma fila Redis.

---

## ADR-023 — `POST /policies` desfaz o INSERT local quando a AMAPI recusa o payload

**Contexto:** achado durante o próprio teste de integração da fase: o fluxo de criação insere
a política localmente PRIMEIRO (pra ter um `id` e montar o `amapiName`), só depois tenta
enviar pra AMAPI. Sem tratamento, uma falha da AMAPI (ex.: payload rejeitado com 400) deixava
uma linha "fantasma" em `politicas` — sem `amapiName`, sem nenhuma versão em
`politicas_versoes` — que `PATCH`/`DELETE` não sabem tratar corretamente.

**Decisão:** no `catch` do envio à AMAPI, a rota apaga a linha recém-inserida
(`db.delete(politicas).where(...)`) antes de responder 502. Seguro porque nenhuma
`politicas_versoes` ainda foi gravada nesse ponto — não sobra histórico órfão.

**Consequência:** uma política só existe localmente quando existe nos dois lados (nosso banco
E a AMAPI) — nunca um meio-termo inconsistente. Se a criação falhar, o cliente da API recebe
502 e pode simplesmente tentar de novo (o nome não ficou "reservado" por uma tentativa
fracassada).

---

## ADR-024 — Dado sensível nunca persistido no histórico de comandos

**Contexto:** `POST /devices/:id/comandos` (RESET_PASSWORD) recebe `novaSenha` no corpo da
requisição. `comandos.payload` (jsonb) é visível via `GET /devices/:id/comandos` pra
`VIEWER`/`TECNICO`/`ADMIN` — gravar a senha nova ali, mesmo que "só pra auditoria", criaria um
texto puro de credencial num lugar lido por três papéis diferentes.

**Decisão:** `payloadParaHistorico` (`src/modules/devices/devices.routes.ts`) é uma
allowlist, não uma cópia do body — só grava o que cada tipo de comando precisa pra contexto
futuro (`pacotes` em CLEAR_APP_DATA, `motivo` em WIPE); `novaSenha` nunca entra na lista.

**Consequência:** o histórico de um comando RESET_PASSWORD não mostra qual foi a senha
definida — se isso um dia for um requisito de auditoria de verdade, a resposta é integrar com
um cofre de segredos dedicado, não gravar em texto puro numa coluna jsonb comum.

---

## ADR-025 — Gaps de RBAC resolvidos por extensão de padrão já confirmado

**Contexto:** dois gaps que nem a seção 5 nem `src/domain/auth/permissions.ts` cobrem
explicitamente: (1) qual papel pode emitir `RELINQUISH_OWNERSHIP` (a lista de permissões lista
`dispositivos:comando:wipe` como `ADMIN`-only mas nunca menciona relinquish-ownership); (2)
quem pode gerenciar `colaboradores`/`linhas` (a lista só menciona
`colaboradores:vincular-dispositivo`/`linhas:vincular-dispositivo`, sobre VINCULAR a um
device — não sobre CRUD do cadastro em si).

**Decisão:** `RELINQUISH_OWNERSHIP` tratado como `ADMIN`-only, mesmo nível de `WIPE` — as duas
tiram o device do controle da gestão de forma pouco reversível. CRUD de `colaboradores`/
`linhas`: leitura pra `VIEWER`/`TECNICO`/`ADMIN`, escrita pra `TECNICO`/`ADMIN`, `AUDITOR` de
fora dos dois — extensão direta da mesma filosofia do ADR-004 (`AUDITOR` só enxerga
`GET /auditoria`, nunca inventário/cadastro operacional).

**Consequência:** resolvido por extensão de padrão já confirmado com o Victor (ADR-004), não
por decisão nova e isolada — mas registrado aqui porque é uma interpretação, não um valor
explícito da spec. Se o Victor discordar de algum dos dois no uso real, é um ajuste pontual de
`withRole(...)`, não uma mudança estrutural.

---

## ADR-026 — Localização fora de escopo na Fase 6 (AMAPI não coleta continuamente)

**Contexto:** ao planejar a retenção LGPD (`COLETA_LOCALIZACAO_ATIVA`, `RETENCAO_LOCALIZACAO_
DIAS`, ambas já documentadas em `.env.example` desde fases anteriores), fui conferir como a
AMAPI de fato relata localização — e a resposta muda o escopo da feature. A AMAPI **não**
relata localização de forma contínua/periódica via `STATUS_REPORT`. O único recurso que expõe
coordenadas é `LostModeLocationEvent`, parte de `SECURITY_LOGS`/`USAGE_LOGS`, e só existe
quando alguém explicitamente coloca o device em "Lost Mode" via um comando dedicado
(`startLostMode`) — não é uma coleta de rastreamento contínua que dá pra ligar/desligar com
uma flag geral, como `COLETA_LOCALIZACAO_ATIVA` sugere.

**Decisão (perguntado ao Victor, que confirmou):** Fase 6 não implementa nenhuma coleta de
localização de verdade nem os comandos `START_LOST_MODE`/`STOP_LOST_MODE`. `dispositivos.
ultima_localizacao` continua existindo (seção 6) mas nunca é preenchida por nenhum handler.
`COLETA_LOCALIZACAO_ATIVA` segue documentada só em `.env.example`, sem entrar em
`src/config/env.ts` (nenhum código a lê ainda — regra do topo daquele arquivo).
`RETENCAO_LOCALIZACAO_DIAS` idem — sem função até essa coluna passar a ser preenchida.

**Consequência:** se um recurso de "encontrar device perdido" for pedido no futuro, é aditivo
(dois comandos novos no enum `comando_tipo`, um handler de evento pro `LostModeLocationEvent`)
— não uma correção do que já existe.

---

## ADR-027 — `alertas.dispositivo_id` nullable + `linha_id` novo (LINHA_SEM_USO)

**Contexto:** a seção 6 define `alertas.dispositivo_id` como `NOT NULL` (todo alerta é sobre
um dispositivo). A seção 9 lista `LINHA_SEM_USO` como um dos 9 tipos — mas por definição esse
alerta é sobre uma LINHA sem NENHUM dispositivo usando ela; não existe um `dispositivo_id`
sensato pra anexar. Schema (seção 6) e lista de tipos (seção 9) conflitam neste um ponto.

**Decisão:** `dispositivo_id` passou a ser nullable; `linha_id` (nullable, FK pra `linhas`) foi
adicionado. Um `CHECK` garante que exatamente um dos dois está preenchido (nunca os dois,
nunca nenhum) — `drizzle/migrations/0004_alertas_linha_sem_uso.sql`. Um segundo índice único
parcial (`alertas_linha_aberto_unico_idx`) replica pra `linha_id` a mesma garantia de "um
alerta aberto por chave+tipo" que já existia pra `dispositivo_id` (ADR-020) — dois índices
separados, não um composto, porque Postgres trata `NULL` como distinto de `NULL` em índice
único (um índice composto `(dispositivo_id, linha_id, tipo)` não impediria duas linhas de
`LINHA_SEM_USO` pra mesma linha).

**Consequência:** `abrirAlertaSeNaoExistir` (`src/domain/alertas/repositorio.ts`) escolhe o
índice certo (`target`) olhando se `linhaId` veio preenchido no input — o único lugar do
código que precisa saber que existem dois "modos" de alerta.

---

## ADR-028 — `AUDITOR` ganha acesso a `GET /alertas` e `GET /dashboard`

**Contexto:** ao contrário de `/devices/*`/`/colaboradores`/`/linhas` (ADR-004/ADR-025,
`AUDITOR` de fora), a lista de permissões da seção 5 (`src/domain/auth/permissions.ts`, desde
a Fase 2) já declara `compliance:ler` pro papel `AUDITOR` — uma permissão que não tinha
nenhuma rota correspondente até agora. Boa parte dos 9 alertas (`NAO_CONFORME`,
`PATCH_DESATUALIZADO`, `SO_OBSOLETO`) É literalmente sinal de compliance, não inventário
operacional de dispositivo.

**Decisão:** `GET /alertas`, `GET /alertas/:id` e `GET /dashboard` aceitam `AUDITOR` (além de
`VIEWER`/`TECNICO`/`ADMIN`). Ações de escrita (`POST /alertas/:id/reconhecer`/`resolver`)
continuam `TECNICO`/`ADMIN`-only — reconhecer/resolver é ação operacional, não leitura de
compliance.

**Consequência:** primeira rota que de fato usa a permissão `compliance:ler` declarada desde a
Fase 2 — antes disso, `AUDITOR` só tinha `GET /auditoria` (`auditoria:ler`) de verdade.

---

## ADR-029 — `BATERIA_DEGRADADA` mede carga crítica, não degradação física

**Contexto:** o nome do alerta (seção 9) sugere medir desgaste/saúde da bateria. A AMAPI não
expõe isso: `Schema$PowerManagementEvent` (o único dado de bateria disponível) só tem
`batteryLevel`, um percentual de CARGA no momento do evento — não existe campo de
battery health/wear/capacity no schema atual da AMAPI.

**Decisão:** interpretação adotada — "bateria criticamente baixa no último check-in"
(`ALERTA_BATERIA_CRITICA_PCT`, default 15%) — o proxy mensurável mais próximo do nome do
alerta que os dados disponíveis permitem, não uma medição real de degradação.

**Consequência:** um device com bateria fisicamente degradada mas que está carregado no
momento do `STATUS_REPORT` não dispara o alerta — a limitação é do dado de origem, não da
lógica. Se "degradação de verdade" for um requisito real, exigiria um recurso da AMAPI que não
existe hoje (ou heurística baseada em histórico de tempo-de-carga, fora de escopo).

---

## ADR-030 — `SO_OBSOLETO` compara versão "major" via tabela SDK→versão, não SDK direto

**Contexto:** `ANDROID_VERSAO_MINIMA_SDK` (documentada desde a Fase 3) sugere comparar contra
o nível de API (SDK) do device. A AMAPI não expõe isso — `SoftwareInfo.androidVersion` é a
versão "visível ao usuário" (ex.: "13", "6.0.1"), não um inteiro de API level.

**Decisão:** uma tabela fixa `SDK_PARA_VERSAO_MAJOR` (`src/domain/alertas/motor.ts`), cobrindo
API 21–35, converte o SDK mínimo configurado pra uma versão major do Android; o device é
comparado por essa versão major (primeiro número de `androidVersion`), não pelo SDK
diretamente. SDK fora da tabela (config inválida) resolve pra `0` — nunca marca a frota
inteira como obsoleta por um número de configuração errado.

**Consequência:** precisão no nível de "major version", não de patch/minor — suficiente pro
propósito do alerta (frota rodando Android muito antigo), não uma comparação de API level
exata. Tabela precisa de uma entrada nova a cada Android major novo (baixa manutenção, uma
linha por ano aproximadamente).

---

## ADR-031 — Limiares do motor de alertas são env vars com default, não valores fixos

**Contexto:** a seção 9 nomeia os 9 tipos de alerta, mas nenhum limiar numérico (quantos dias
sem check-in, quantos MB de storage, qual % de bateria, etc.) é especificado — decisão de
negócio que ninguém definiu ainda, mesmo padrão do ADR-016 (seed de políticas).

**Decisão:** cada limiar é uma env var com um default conservador, documentada em
`src/config/env.ts`: `ALERTA_SEM_CHECKIN_DIAS` (3), `ALERTA_PATCH_MAX_DIAS` (90),
`ALERTA_STORAGE_CRITICO_MB` (500), `ALERTA_BATERIA_CRITICA_PCT` (15),
`ALERTA_DISPOSITIVO_ORFAO_DIAS` (7), `ALERTA_SCAN_INTERVALO_HORAS` (6, intervalo do scan
periódico, não um limiar de alerta em si).

**Consequência:** ajustável sem redeploy de código (só reiniciar com a env var nova). Valores
atuais são palpites informados, não medição da operação real da empresa — revisar assim que
houver dado real de uso (quantos alertas cada limiar gera por semana, se está barulhento
demais ou silencioso demais).

---

## ADR-032 — `PATCH /usuarios/:id` ganha `ativo`, reaproveitando a trava do último ADMIN

**Contexto:** revisão de UX do painel (sessão de 16/10) achou que não existia nenhuma forma
de desligar o acesso de um usuário que saiu da empresa — `usuarios.ativo` já bloqueava
login/refresh (`provisionarUsuario`/`POST /auth/refresh`) desde sempre, mas nada na API
conseguia setá-lo como `false` depois da criação.

**Decisão:** `PATCH /usuarios/:id` passa a aceitar `role` e/ou `ativo`, os dois opcionais
(pelo menos um obrigatório — 422 "Nada para atualizar" se nenhum vier). A trava do ADR-013
("não remover o último ADMIN") é generalizada: bloqueia tanto rebaixar quanto **desativar**
o único ADMIN ativo, mesma chamada a `contarAdminsAtivos()`. `atualizarRole` virou
`atualizarUsuario(id, { role?, ativo? })` em `src/domain/usuarios/repositorio.ts` — um só
`UPDATE`, o chamador decide quais campos entram.

**Consequência:** nenhuma mudança no fluxo de login/refresh em si (já checava `ativo`) — só
a rota de gestão ganhou a capacidade que faltava. Auditoria registra `USUARIO_ATIVO_ALTERADO`
separado de `USUARIO_ROLE_ALTERADA` (a UI do painel só manda um campo por vez, nunca os
dois). Testado em `test/integration/rbac.test.ts`.

## ADR-033 — Índices faltando em 4 colunas de filtro frequente

**Contexto:** auditoria de performance (sessão de 17/10) comparou toda coluna usada em
`WHERE`/`eq()` nos repositórios de domínio contra os índices declarados em `src/db/schema/*.ts`.
Achou 4 colunas filtradas com frequência sem índice nenhum, cada uma causando sequential scan
na tabela inteira:

- `refresh_tokens.token_hash` — a mais crítica das três: é o lookup de **todo** `POST
/auth/refresh` (`src/domain/auth/refresh-tokens.ts:163`), que roda a cada renovação de
  sessão de cada usuário ativo. A tabela também não tem nenhuma purga de tokens
  expirados/revogados (diferente de `eventos_brutos`, que já tem `purgarEventosBrutosAntigos`
  rodando no worker de manutenção) — só cresce.
- `comandos.dispositivo_id` — filtro de `GET /devices/:id/comandos`
  (`src/domain/comandos/repositorio.ts:17`), a aba "Comandos" visitada toda vez que alguém
  abre a tela de detalhe de um dispositivo no painel.
- `dispositivos.politica_id` — filtro de `GET /devices?politicaId=`
  (`src/domain/dispositivos/repositorio.ts:223`).
- `politicas_versoes.politica_id` — filtro de `GET /policies/:id/versoes` e do lookup de
  `POST /policies/:id/rollback` (`src/modules/politicas/politicas.routes.ts:297,521`), numa
  tabela append-only (nunca tem UPDATE/DELETE, só cresce a cada edição de política).

**Decisão:** 4 índices B-tree simples adicionados via `drizzle-kit generate`
(`drizzle/migrations/0005_indices_performance.sql`) — nenhuma mudança de comportamento, só
leitura mais rápida. A purga de `refresh_tokens` antigos **não** entrou neste ADR: apagar
tokens quebraria a cadeia `substituido_por` ("percorrível pra auditoria — esse token foi
rotacionado N vezes desde o login", comentário em `src/db/schema/refresh-tokens.ts`), que é
um objetivo de produto documentado, não um acidente — resolvido separadamente no ADR-034.

**Consequência:** sem mudança de contrato de API nem de comportamento — só os 4 `CREATE
INDEX`. Suíte completa re-rodada após a migration pra confirmar que nada depende de plano de
execução (nenhum teste deveria, mas é o mesmo rigor de qualquer mudança de schema nesta
sessão).

## ADR-034 — Retenção de `refresh_tokens`: purga após 30 dias de expirado, FK vira `SET NULL`

**Contexto:** ADR-033 achou que `refresh_tokens` nunca tinha purga (diferente de
`eventos_brutos`, que já purga via `RETENCAO_EVENTOS_BRUTOS_DIAS`) e deixou a decisão de
retenção pendente, porque apagar tokens sem cuidado quebra a FK auto-referente
`substituido_por` — um token antigo pode ainda ser apontado por outro, mais antigo, como "o
que me substituiu".

**Decisão:**

1. `substituido_por` ganha `onDelete: 'set null'` (`drizzle/migrations/
0006_refresh_tokens_fk_set_null.sql`) — apagar um token nunca mais quebra com erro de FK;
   na pior hipótese, a cadeia perde o elo mais antigo e o próximo passa a apontar pra `null`
   em vez de continuar a história pra trás daquele ponto.
2. Novo `purgarRefreshTokensAntigos()` (`src/domain/lgpd/retencao.ts`), mesmo padrão de
   `purgarEventosBrutosAntigos` — apaga tokens com `expira_em` mais antigo que
   `RETENCAO_REFRESH_TOKENS_DIAS` (nova env var, default **30 dias**), rodando junto no
   worker de manutenção a cada ciclo (`ALERTA_SCAN_INTERVALO_HORAS`).
3. Filtra por `expira_em`, não por `revogado_em` — cobre tanto token revogado quanto sessão
   simplesmente abandonada (usuário nunca mais voltou a renovar).

**Por que 30 dias:** margem bem maior que qualquer investigação de segurança plausível
precisaria (um token expirado não é mais utilizável pra autenticar nada — reter mais tempo
não adiciona proteção, só armazenamento), e consistente com o espírito de minimização de
dados do restante do projeto (`RETENCAO_LOCALIZACAO_DIAS`, `RETENCAO_EVENTOS_BRUTOS_DIAS`).

**Consequência:** a cadeia de rotação deixa de ser permanente — só os últimos ~30 dias após
expirar ficam retidos, não para sempre. Isso é uma mudança de comportamento real (ao
contrário do ADR-033), por isso ADR separado. Testado em `test/integration/
motor-alertas.test.ts`, incluindo o caso de uma cadeia de 2 elos expirados sendo apagada
junto sem violar a FK.

## ADR-035 — Auditoria de segurança (red/blue team) antes do handoff: 2 achados corrigidos

**Contexto:** antes de transferir os dois repositórios pro time de dev/infra da empresa,
sessão de 18/10 fez uma bateria de testes reais de ataque contra o servidor local (não só
revisão de código) — bypass de autenticação, `alg: none` em JWT, escalação de privilégio com
token legítimo de papel baixo, injeção de SQL nos filtros de busca, path traversal,
exposição de CORS, headers de segurança, `npm audit` nos dois repositórios.

**O que já estava correto (confirmado, não só assumido) e não mudou:**

- `jose` com `algorithms: ['HS256']` fixo na verificação — tentativa de forjar JWT com
  `alg: none` recusada com 401, não aceita silenciosamente.
- RBAC: token legítimo de `VIEWER` barrado com 403 em toda rota de escrita testada
  (`PATCH /usuarios/:id`, `POST /devices/:id/comandos` com `WIPE`, `POST /policies`,
  `POST /internal/sync/devices`).
- Filtros de busca (`ilike`) tratam payload de SQL injection como string literal — Drizzle
  parametriza a query, `escaparTermoBusca` escapa wildcard de propósito; nenhum erro de SQL,
  nenhum vazamento.
- `params.id` com payload de path traversal/injection é rejeitado com 400 pelo Zod antes de
  qualquer query no banco (`Invalid uuid`).
- `@fastify/helmet` já registrado: CSP, HSTS, X-Content-Type-Options, X-Frame-Options,
  X-DNS-Prefetch-Control todos presentes.
- CORS: origem fora de `ALLOWED_ORIGINS` nunca recebe `Access-Control-Allow-Origin` — browser
  bloqueia a leitura da resposta mesmo com `credentials: true` setado.
- Fluxo OIDC (`src/domain/auth/oidc-state.ts`): `state` é um JWT assinado (não um valor
  arbitrário confiado cegamente), carrega `code_verifier`/`nonce` (PKCE), `issuer` próprio
  (`...oidc-state`, diferente do token de sessão — os dois nunca são intercambiáveis mesmo
  compartilhando o mesmo `JWT_SECRET`). Redirect final sempre pra `env.FRONTEND_URL`
  (configurado pelo servidor) — nunca um parâmetro vindo do cliente, zero risco de open
  redirect.
- Cookie `mdm_refresh_token`: `httpOnly`, `secure` (produção), `sameSite: 'lax'`.

**Achado 1 — `/docs`/`/docs/json` (Swagger UI) expostos sem autenticação:** qualquer um,
sem token, via a URL pública do backend, veria o mapa completo da API — inclusive rotas
internas (`/internal/pubsub/replay`). Não dava pra proteger com `withRole` (rota registrada
pelo plugin `@fastify/swagger-ui`, fora do fluxo `register*Routes`). **Decisão:** registra
`@fastify/swagger`/`@fastify/swagger-ui` só quando `NODE_ENV !== 'production'`
(`src/app.ts`) — mesmo padrão condicional já usado pro transport `pino-pretty` do logger.
Quem precisa do contrato em produção usa `docs/openapi.json` (committed, mantido em
sincronia por CI). Provado ao vivo: `GET /docs` com `NODE_ENV=production` → 404.

**Achado 2 — `uuid < 11.1.1` (CVE moderada, GHSA-w5hq-g745-h8pq) via `exceljs`:**
`npm audit` acusou, mas a função vulnerável (`v3`/`v5`/`v6` com buffer) nunca é chamada —
`exceljs` só usa `uuid.v4()` (confirmado via `grep` no pacote instalado), não afetado pela
CVE. Não explorável na prática, mas corrigido mesmo assim (zero custo, zero risco de quebra):
`"overrides": { "exceljs": { "uuid": "^11.1.1" } }` no `package.json`. `npm audit --omit=dev`
(só o que de fato entra na imagem Docker) confirma **0 vulnerabilidades** nos dois
repositórios depois da correção.

**Fora de escopo, aceito como está:** as ~11 vulnerabilidades restantes do `npm audit` em
cada repositório são todas de devDependencies (`testcontainers`, `drizzle-kit`/`esbuild` no
backend; `eslint-config-next` no frontend) — nunca entram na imagem de produção
(`npm ci --omit=dev` no `Dockerfile`, confirmado). Corrigir exigiria downgrade/upgrade com
breaking change em ferramenta de teste/lint, sem ganho de segurança real em produção —
não forçado sem necessidade.

**Consequência:** suíte completa (346 testes) re-rodada depois da mudança em `app.ts`,
mesmo rigor de qualquer alteração nesta sessão.
