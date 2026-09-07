# Setup

## Escopo deste documento nesta fase

Cobre o que as **Fases 1 a 4** já entregam: rodar a aplicação, Postgres e Redis localmente,
migrations, login corporativo via OIDC, ambiente GCP (enterprise AMAPI, service account,
Pub/Sub), o worker de eventos e os testes. A seção de **primeiro enrollment ponta a ponta**
depende do nome real da enterprise (ainda placeholder — ver ADR-005): os passos de setup do
GCP abaixo já valem, o que falta é só o Victor confirmar esse valor com a empresa.

## Pré-requisitos

- Node.js ≥ 22
- Docker Desktop com Compose v2 (usado tanto para rodar a stack quanto pelos testes de
  integração via Testcontainers)
- Em Windows: Docker Desktop precisa estar com o backend WSL2 ativo e rodando antes de
  `npm test` ou `docker compose up` — sem isso o Testcontainers falha ao tentar abrir o
  socket do Docker.

## Passo a passo local

```bash
git clone https://github.com/victor-germano/Sistema-de-monitoramento-de-celulares-para-infraestrutura.git
cd Sistema-de-monitoramento-de-celulares-para-infraestrutura
cp .env.example .env
npm install
docker compose up -d postgres redis
npm run dev
```

Verificar: `curl http://localhost:13000/health` deve responder `200` com
`{"status":"ok", "checks": {"database":{"status":"up"}, "redis":{"status":"up"}}}`.

## Variáveis de ambiente

Todas documentadas com comentário inline em [`.env.example`](../.env.example), agrupadas por
fase (as da Fase 1 e 2 já são lidas pelo código — as de Fase 3+ estão documentadas mas ainda
não têm efeito, ver `src/config/env.ts`):

| Variável                                                           | Fase | Descrição                                                                                                  |
| ------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                         | 1    | `development` \| `test` \| `production`                                                                    |
| `PORT`                                                             | 1    | Porta HTTP do Fastify                                                                                      |
| `LOG_LEVEL`                                                        | 1    | Nível do Pino                                                                                              |
| `ALLOWED_ORIGINS`                                                  | 1    | Origens de CORS, separadas por vírgula                                                                     |
| `DATABASE_URL`                                                     | 1    | Conexão Postgres                                                                                           |
| `POSTGRES_USER/PASSWORD/DB`                                        | 1    | Usados pelo `docker-compose.yml` para subir o Postgres local                                               |
| `REDIS_URL`                                                        | 1    | Conexão Redis                                                                                              |
| `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI`                 | 2    | Provedor OIDC (ver ADR-003)                                                                                |
| `ALLOWED_EMAIL_DOMAINS`                                            | 2    | Domínios aceitos no login (`gruporoveri.com.br`)                                                           |
| `JWT_SECRET`, `JWT_SESSION_TTL_MINUTES`, `REFRESH_TOKEN_TTL_HOURS` | 2    | Sessão interna                                                                                             |
| `AMAPI_ENTERPRISE_NAME`                                            | 3    | Placeholder — ver ADR-005                                                                                  |
| `AMAPI_SERVICE_ACCOUNT_KEY_PATH`                                   | 3    | Caminho local do JSON da service account                                                                   |
| `GOOGLE_CLOUD_PROJECT`, `PUBSUB_SUBSCRIPTION`                      | 4    | Validadas e lidas de verdade pelo worker; valores ainda placeholder — ADR-005                              |
| `PUBSUB_TOPIC`                                                     | 4    | Só referência/documentação — quem publica é a própria AMAPI, o código nunca lê esta variável (ver ADR-017) |
| `ANDROID_VERSAO_MINIMA_SDK`                                        | 6    | Default SDK 30, ajustável                                                                                  |
| `COLETA_LOCALIZACAO_ATIVA`, `RETENCAO_*`                           | 6    | LGPD/retenção                                                                                              |
| `ALERT_WEBHOOK_URL`                                                | 6    | Webhook genérico (Teams/Slack)                                                                             |

## Migrations

```bash
npm run db:migrate
```

Aplica todas as migrations em `drizzle/migrations/` (schema completo da seção 6 + o trigger
de append-only da `auditoria`, ver ADR-008) contra o Postgres apontado por `DATABASE_URL`.
`npm run db:generate` gera uma nova migration a partir de mudanças em `src/db/schema/`.

## Login corporativo (OIDC) — configuração local

Pra testar o fluxo de login de verdade (não só os testes automatizados, que mockam a troca
de código por token — ver "Testes" abaixo):

1. No [Google Cloud Console](https://console.cloud.google.com/apis/credentials), crie uma
   credencial OAuth 2.0 do tipo "Aplicativo da Web".
2. Em "URIs de redirecionamento autorizados", adicione exatamente o valor de
   `OIDC_REDIRECT_URI` (`http://localhost:13000/auth/callback` em dev).
3. Copie o Client ID/Secret gerados para `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` no `.env`.
4. Adicione seu próprio e-mail `@gruporoveri.com.br` (ou o domínio configurado em
   `ALLOWED_EMAIL_DOMAINS`) em `BOOTSTRAP_ADMIN_EMAILS`, pra já entrar como `ADMIN` no
   primeiro login em vez de `VIEWER` (ver ADR-012).
5. Suba a API (`npm run dev`) e acesse `http://localhost:13000/auth/login` no browser.

Login bem-sucedido termina redirecionando pra `FRONTEND_URL` com um cookie `mdm_refresh_token`
(httpOnly) setado — sem frontend ainda, confirme com as ferramentas de dev do browser
(Application → Cookies) e chamando `POST /auth/refresh` (com esse cookie) pra obter o
primeiro access token. Contrato completo em `docs/DECISOES.md` (ADR-010).

> **Nota:** este é o único passo de validação do login que é manual, não automatizado — a
> troca de `code` por token acontece contra o Google de verdade, e não há como isso rodar em
> CI sem credenciais reais. Os testes automatizados (`test/integration/auth-flow.test.ts`)
> cobrem toda a lógica ao redor disso (validação de domínio, provisionamento, cookie,
> rotação, auditoria) mockando só essa chamada de rede pontual.

## Testes

```bash
npm test
npm run test:coverage
```

Os testes de integração sobem Postgres e Redis reais via Testcontainers — não usam o
`docker-compose.yml` nem dependem dele estar de pé; cada teste sobe e derruba seus próprios
containers, roda as migrations reais e, quando precisa, semeia usuários de teste direto no
banco. Exige só o Docker daemon acessível.

> **Se a suíte demorar muito ou flacar com "Hook timed out" na criação de container:** a
> partir da Fase 4 há 10+ arquivos de integração via Testcontainers, e a suíte roda em série
> (`fileParallelism: false`, ADR-021) exatamente por isso — paralelismo, mesmo limitado por
> thread, gerou overhead de orquestração grande demais no Docker Desktop desta máquina
> (Windows/WSL2). Se mesmo em série a suíte flacar: confira `docker ps`/`docker stats` por
> containers de OUTRO projeto competindo pela mesma memória (foi a causa raiz encontrada aqui
> — pare os que não precisar) e Settings → Resources → Memory do Docker Desktop. Não é falha
> de código — um `docker run postgres` isolado sobe em ~1s quando o daemon está saudável.

## Ambiente Google Cloud (GCP) e primeiro enrollment

### 1. Service account da AMAPI

1. No [Google Cloud Console](https://console.cloud.google.com/), no projeto vinculado à
   enterprise da AMAPI, ative a **Android Management API**.
2. Crie uma service account (IAM & Admin → Service Accounts) e gere uma chave JSON.
3. Salve o arquivo localmente e aponte `AMAPI_SERVICE_ACCOUNT_KEY_PATH` pra ele — **nunca
   commitar esse arquivo** (já está no `.gitignore`).
4. `AMAPI_ENTERPRISE_NAME` (`enterprises/<id>`) é o recurso da enterprise já vinculada a esse
   projeto — este sistema nunca cria uma enterprise em runtime (seção 2), só usa uma que já
   existe. **Placeholder até o Victor confirmar o valor real com a empresa (ADR-005)** — sem
   ele, o adapter AMAPI (Fase 3) e o consumer (Fase 4) só funcionam contra mocks nos testes,
   nunca contra a AMAPI de verdade.

### 2. Tópico e subscription do Pub/Sub

1. Crie um tópico Pub/Sub no mesmo projeto GCP (Pub/Sub → Topics → Create Topic).
2. Na [configuração de notificações da AMAPI](https://developers.google.com/android/management/notifications),
   registre esse tópico pra enterprise (`enterprises.patch` com `enterpriseNotificationConfig`, ou pelo
   console) — é isso que faz a AMAPI publicar eventos de device nele.
3. Crie uma subscription **pull** (não push) nesse tópico — é o modo que
   `src/workers/pubsub-consumer.ts` usa (`@google-cloud/pubsub`, `subscription.on('message', ...)`).
4. Preencha `GOOGLE_CLOUD_PROJECT` (o project id do GCP) e `PUBSUB_SUBSCRIPTION` (o nome da
   subscription, não o do tópico) no `.env`. `PUBSUB_TOPIC` fica só como referência/documentação —
   o worker nunca lê essa variável, só a subscription (ver ADR-017).
5. A service account de `AMAPI_SERVICE_ACCOUNT_KEY_PATH` precisa do papel
   `roles/pubsub.subscriber` na subscription (ou um papel mais amplo que inclua) — sem isso o
   worker sobe mas fica recebendo `PERMISSION_DENIED` a cada tentativa de pull.

### 3. Subindo o worker

```bash
npm run worker:pubsub
```

Processo separado da API (`npm run dev`) — os dois precisam estar de pé pro fluxo completo
funcionar (API pra criar o token de enrollment, worker pra processar o evento que chega
depois). Ver [`docs/api/pubsub-pipeline.md`](./api/pubsub-pipeline.md) pro comportamento
completo (o que cada `notificationType` faz, idempotência, recuperação de falha).

### 4. Primeiro enrollment de teste

1. Com API e worker de pé, crie um enrollment token (`POST /enrollment/tokens` — seção 10,
   ainda não implementado nesta fase; até lá, inserir manualmente uma linha em
   `enrollment_tokens` com um `politicaId` válido serve pro teste).
2. Gere o QR code / link a partir do token retornado pela AMAPI (`criarEnrollmentToken`,
   `src/integrations/amapi/enrollment.ts`) e escaneie num device Android físico ou emulador
   com Google Play Services.
3. Acompanhe o log do worker — a mensagem `ENROLLMENT: dispositivo provisionado e vinculado`
   confirma que o critério de aceite da Fase 4 aconteceu de verdade: o device apareceu em
   `dispositivos` sozinho, sem nenhum INSERT manual.
4. Confirme via `GET /devices` (precisa de um token de sessão — ver "Login corporativo"
   acima) que o dispositivo está lá, com o vínculo (colaborador/patrimônio/política) que o
   token de enrollment carregava.

**Bloqueado hoje** pela pendência do valor real de `AMAPI_ENTERPRISE_NAME` (ADR-005) — os
passos acima são o procedimento; executá-los de ponta a ponta contra a AMAPI real fica pra
quando a empresa confirmar esse valor.
