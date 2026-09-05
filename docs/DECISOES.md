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
