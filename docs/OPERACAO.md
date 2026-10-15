# Operação

Para quem vai rodar este sistema em produção. Pressupõe que você já leu
`docs/ARQUITETURA.md` (os 4 processos, o fluxo de evento) — este documento é sobre
_rodar_ esses processos de forma segura, não sobre como eles funcionam por dentro.
Setup de ambiente de desenvolvimento está em `docs/SETUP.md`, não repetido aqui.

## Os 4 processos em produção

| Processo                      | Quantas instâncias                                                        | Por quê                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API HTTP                      | **Pode escalar horizontalmente** (N instâncias atrás de um load balancer) | Stateless — sessão é JWT + cookie, nenhum estado em memória entre requisições                                                                                                                                                                                                                                                |
| Worker de escrita de política | **Exatamente 1 instância**                                                | `concurrency: 1` só serializa escritas _dentro do mesmo processo_. Rodar 2 instâncias quebra a garantia que existe pra respeitar o rate limit da AMAPI (ver `docs/ARQUITETURA.md`, seção "Fila de escrita de política") — duas instâncias podem puxar jobs da fila ao mesmo tempo, cada uma com seu próprio `concurrency: 1` |
| Worker de manutenção          | **Exatamente 1 instância**                                                | Timer simples (`setInterval`), não um job distribuído — 2 instâncias rodam o scan e a purga em dobro, desperdiçando trabalho (não quebra dado, mas não tem propósito)                                                                                                                                                        |
| Worker Pub/Sub                | **1 ou mais instâncias** (única exceção que escala)                       | Subscription _pull_ do Google distribui mensagens entre consumidores — rodar 2+ instâncias é uma forma legítima de redundância/throughput, e o processamento já é idempotente por `messageId`                                                                                                                                |

**Resumo prático:** só a API e o worker de Pub/Sub podem ter mais de 1 réplica. Se o seu
orquestrador (K8s, etc.) tiver autoscaling genérico ligado "pra tudo", trave manualmente
os workers de política e manutenção em `replicas: 1`.

### Onde isso roda em produção: Render (backend) + Vercel (frontend)

O `docker-compose.yml` deste repositório só define o serviço `api` — é pensado pra
desenvolvimento/validação local, nunca foi o plano de produção. Decisão tomada: o
**backend (API + 3 workers) roda no Render**, descrito como infraestrutura-como-código
em [`render.yaml`](../render.yaml) na raiz do repositório — um serviço por processo da
tabela acima, cada um já com a imagem Docker existente (só muda o `dockerCommand`) e os
limites de réplica corretos documentados inline no próprio arquivo.

**O domínio da empresa (`gruporoveri.com.br`) fica dividido:**

- O **frontend** (quando existir) vai pro **Vercel**, com o domínio principal (ex.:
  `painel.gruporoveri.com.br`) — é o uso natural do Vercel, com deploy automático a
  cada push e preview por PR de graça.
- O **backend** fica num subdomínio separado no Render (ex.:
  `api.gruporoveri.com.br`), configurado em Settings → Custom Domain do serviço
  `mdm-api` no dashboard do Render.

**Por que não dá pra colocar os workers no Vercel:** o Vercel só executa funções
serverless de curta duração — nenhum dos 3 workers cabe nesse modelo, porque todos são
processos de vida longa por natureza: `worker:pubsub` mantém uma conexão de assinatura
pull aberta o tempo todo (não é algo que "termina e retorna uma resposta"),
`worker:policy-write` e `worker:manutencao` dependem de um processo persistente rodando
em segundo plano. Só a API HTTP (`mdm-api`) teria, em tese, esse formato request/response
compatível com serverless — mas separar só ela pro Vercel criaria dois lugares de deploy
pro mesmo conjunto de código, sem ganho real; mantê-la junto dos workers no Render evita
essa fragmentação.

**Antes do primeiro deploy real**, confira no dashboard do Render:

1. Validar o `render.yaml` (New → Blueprint, apontando pro repositório) — a sintaxe de
   alguns campos pode mudar entre versões da plataforma, o arquivo tem um aviso sobre
   isso no topo.
2. Preencher manualmente os valores marcados `sync: false` no `envVarGroups` (segredos
   OIDC, nome da enterprise AMAPI, etc. — nunca ficam no `render.yaml` em texto plano).
3. Subir o JSON da service account da AMAPI como um **Secret File** do serviço
   `mdm-api` (nunca como env var de texto nem commitado).

## Variáveis de ambiente em produção

Todas as variáveis já estão documentadas em `.env.example` e `docs/SETUP.md`. Dois
cuidados que só importam em produção, não em dev:

- **`JWT_SECRET`** — gere um valor único por ambiente (`openssl rand -base64 48`, como
  o comentário no `.env.example` já sugere) e trate como segredo de verdade (secret
  manager do orquestrador, nunca em variável de ambiente plana num repositório de infra
  público). Nunca reutilize o mesmo segredo entre staging e produção — invalida todas
  as sessões do outro ambiente se vazar.
- **`AMAPI_SERVICE_ACCOUNT_KEY_PATH`** — aponta pra um arquivo JSON que **não é
  copiado pra dentro da imagem Docker** (confirme: não há `COPY` dele no `Dockerfile`,
  de propósito). Em produção, esse arquivo precisa ser montado como volume/secret no
  runtime (ex.: Kubernetes Secret montado como arquivo, AWS Secrets Manager com
  sidecar, etc.) — nunca commitado, nunca embutido na imagem.

## Migrations no pipeline de deploy

`npm run db:migrate` precisa rodar **antes** da nova versão da API/workers começar a
receber tráfego — tipicamente um passo isolado no pipeline de CI/CD (job separado do
deploy da aplicação), não algo que a própria API roda sozinha no boot. O schema está
em `src/db/schema/`, as migrations geradas em `drizzle/migrations/` (versionadas em
git, aplicadas em ordem).

## O que monitorar

Não há métricas/tracing configurados ainda (nenhum Prometheus/OpenTelemetry) — o que
existe hoje é só log estruturado (Pino, JSON em produção) e os healthchecks abaixo.
Até isso ser implementado, o jeito de saber que o sistema está saudável é:

| Sinal                                                                   | Onde olhar                                            | O que significa se estiver errado                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                           | Qualquer instância da API                             | `database`/`redis` com status diferente de `up` — conectividade real, não só "processo de pé"                                                                                                            |
| Log `"Pub/Sub: nenhuma mensagem processada há muito tempo"`             | Log do worker Pub/Sub                                 | 15+ minutos sem processar nenhum evento — a AMAPI manda `STATUS_REPORT` continuamente pra toda a frota, silêncio longo é subscription travada ou credencial expirada, não "frota parada" de verdade      |
| Log `"falha ao processar job de escrita de política"`                   | Log do worker de política                             | Alguma escrita de política falhou — checar se é erro transitório (retry automático já tentou 5x em 429/5xx) ou payload recusado de vez                                                                   |
| Linhas em `eventos_brutos` com `erro` preenchido e `processado_em` nulo | Query direta no Postgres (ainda não exposto por rota) | Eventos que falharam e não foram reprocessados — candidatos a `POST /internal/pubsub/replay`                                                                                                             |
| Contagem de `alertas` abertos por tipo                                  | `GET /dashboard`                                      | Pico repentino pode ser sintoma real (lote de devices ficou `NON_COMPLIANT`) ou limiar mal calibrado (ver `ALERTA_*` em `docs/api/alertas.md`) — os dois merecem investigação, não só silenciar o alerta |

## Runbook — problemas mais prováveis

**Worker de Pub/Sub parado silenciosamente (watchdog disparou):**

1. Confira se o processo está de pé (`docker ps`/orquestrador) — se caiu, suba de novo.
2. Se está de pé mas o watchdog continua disparando: provavelmente a credencial da
   service account expirou/foi revogada, ou a subscription foi deletada no GCP. Verifique
   nos logs se há `PERMISSION_DENIED` ou erro de autenticação.
3. Depois de corrigir, eventos que a AMAPI tentou entregar nesse intervalo chegam via
   redelivery automática do Pub/Sub (at-least-once) — não precisa reprocessar manualmente,
   a menos que o log mostre mensagens que já passaram do prazo de redelivery do Google.

**Escrita de política travada (fila não anda):**

1. Confira se existe **mais de uma instância** do worker de política rodando — sintoma
   seria jobs sendo processados fora de ordem ou duas escritas conflitantes na AMAPI. Se
   for isso, derrube o excedente imediatamente.
2. Se há só 1 instância e mesmo assim não anda: cheque conectividade com Redis
   (`REDIS_URL`) — o worker depende de uma conexão dedicada pra isso.

**Alertas periódicos (`SEM_CHECKIN`/`DISPOSITIVO_ORFAO`/`LINHA_SEM_USO`) não atualizam:**

1. Confirme que o `worker:manutencao` está de pé — sem ele, só os 5 alertas reativos
   funcionam (os que dependem de `STATUS_REPORT` continuam normais).
2. Pode disparar manualmente sem esperar o próximo ciclo: `POST /internal/alertas/verificar`
   (`ADMIN`).

**Evento Pub/Sub processado errado / schema mudou:**

- `POST /internal/pubsub/replay` reprocessa um evento já gravado em `eventos_brutos`
  usando o handler atual — útil depois de corrigir um bug de mapeamento sem precisar que
  a AMAPI reenvie o evento original.

## Backup e retenção

- **Backup do Postgres:** não configurado neste repositório — é responsabilidade do
  ambiente de produção escolhido (snapshot do RDS/Cloud SQL, `pg_dump` agendado, etc.).
  Nenhuma tabela tem proteção especial além do trigger de append-only em `auditoria`
  (ADR-008) — um backup regular do banco inteiro continua necessário.
- **Retenção de `eventos_brutos`:** purgado automaticamente pelo worker de manutenção
  após `RETENCAO_EVENTOS_BRUTOS_DIAS` (padrão 180 dias) — ver `docs/LGPD.md`.

## Encerramento gracioso

A API e os workers tratam `SIGTERM`/`SIGINT` (orquestradores mandam `SIGTERM` antes de
matar um pod/container): a API drena requisições em voo antes de fechar conexões de
banco/Redis; o worker de política fecha a fila BullMQ; o worker de Pub/Sub remove o
listener e fecha a subscription antes de sair. Dar tempo suficiente (`terminationGracePeriodSeconds`
no K8s, por exemplo) antes do `SIGKILL` evita mensagem perdida ou conexão cortada no meio.
