# Setup

## Escopo deste documento nesta fase

Cobre o que a **Fase 1** já entrega: rodar a aplicação, Postgres e Redis localmente, e os
testes. As seções de **ambiente GCP** (enterprise AMAPI, service account, Pub/Sub) e
**primeiro enrollment** chegam quando as Fases 2–4 existirem — não documento passo a passo
de algo que o código ainda não usa.

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
fase (só as da Fase 1 são lidas pelo código hoje — as demais estão documentadas mas ainda
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

## Testes

```bash
npm test
```

Os testes de integração sobem Postgres e Redis reais via Testcontainers — não usam o
`docker-compose.yml` nem dependem dele estar de pé; cada teste sobe e derruba seus próprios
containers. Exige só o Docker daemon acessível.

## Ambiente Google Cloud (GCP) e primeiro enrollment

Pendente — chega junto com a Fase 3 (adapter AMAPI) e Fase 4 (Pub/Sub + enrollment), quando
o código realmente consumir `AMAPI_ENTERPRISE_NAME`, a service account e o tópico/subscription.
