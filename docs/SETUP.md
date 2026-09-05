# Setup

## Escopo deste documento nesta fase

Cobre o que as **Fases 1 e 2** já entregam: rodar a aplicação, Postgres e Redis localmente,
migrations, login corporativo via OIDC e os testes. As seções de **ambiente GCP** (enterprise
AMAPI, service account, Pub/Sub) e **primeiro enrollment** chegam quando as Fases 3–4
existirem — não documento passo a passo de algo que o código ainda não usa.

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

Verificar: `curl http://localhost:3000/health` deve responder `200` com
`{"status":"ok", "checks": {"database":{"status":"up"}, "redis":{"status":"up"}}}`.

## Variáveis de ambiente

Todas documentadas com comentário inline em [`.env.example`](../.env.example), agrupadas por
fase (as da Fase 1 e 2 já são lidas pelo código — as de Fase 3+ estão documentadas mas ainda
não têm efeito, ver `src/config/env.ts`):

| Variável                                                           | Fase | Descrição                                                    |
| ------------------------------------------------------------------ | ---- | ------------------------------------------------------------ |
| `NODE_ENV`                                                         | 1    | `development` \| `test` \| `production`                      |
| `PORT`                                                             | 1    | Porta HTTP do Fastify                                        |
| `LOG_LEVEL`                                                        | 1    | Nível do Pino                                                |
| `ALLOWED_ORIGINS`                                                  | 1    | Origens de CORS, separadas por vírgula                       |
| `DATABASE_URL`                                                     | 1    | Conexão Postgres                                             |
| `POSTGRES_USER/PASSWORD/DB`                                        | 1    | Usados pelo `docker-compose.yml` para subir o Postgres local |
| `REDIS_URL`                                                        | 1    | Conexão Redis                                                |
| `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI`                 | 2    | Provedor OIDC (ver ADR-003)                                  |
| `ALLOWED_EMAIL_DOMAINS`                                            | 2    | Domínios aceitos no login (`gruporoveri.com.br`)             |
| `JWT_SECRET`, `JWT_SESSION_TTL_MINUTES`, `REFRESH_TOKEN_TTL_HOURS` | 2    | Sessão interna                                               |
| `AMAPI_ENTERPRISE_NAME`                                            | 3    | Placeholder — ver ADR-005                                    |
| `AMAPI_SERVICE_ACCOUNT_KEY_PATH`                                   | 3    | Caminho local do JSON da service account                     |
| `GOOGLE_CLOUD_PROJECT`, `PUBSUB_TOPIC`, `PUBSUB_SUBSCRIPTION`      | 4    | Em aberto — ver ADR-005                                      |
| `ANDROID_VERSAO_MINIMA_SDK`                                        | 6    | Default SDK 30, ajustável                                    |
| `COLETA_LOCALIZACAO_ATIVA`, `RETENCAO_*`                           | 6    | LGPD/retenção                                                |
| `ALERT_WEBHOOK_URL`                                                | 6    | Webhook genérico (Teams/Slack)                               |

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
   `OIDC_REDIRECT_URI` (`http://localhost:3000/auth/callback` em dev).
3. Copie o Client ID/Secret gerados para `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` no `.env`.
4. Adicione seu próprio e-mail `@gruporoveri.com.br` (ou o domínio configurado em
   `ALLOWED_EMAIL_DOMAINS`) em `BOOTSTRAP_ADMIN_EMAILS`, pra já entrar como `ADMIN` no
   primeiro login em vez de `VIEWER` (ver ADR-012).
5. Suba a API (`npm run dev`) e acesse `http://localhost:3000/auth/login` no browser.

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

## Ambiente Google Cloud (GCP) e primeiro enrollment

Pendente — chega junto com a Fase 3 (adapter AMAPI) e Fase 4 (Pub/Sub + enrollment), quando
o código realmente consumir `AMAPI_ENTERPRISE_NAME`, a service account e o tópico/subscription.
