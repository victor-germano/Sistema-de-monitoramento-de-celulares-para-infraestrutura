# Arquitetura

Documento técnico para quem vai operar, estender ou dar manutenção neste backend.
Pressupõe familiaridade com Node/TypeScript e conceitos gerais de fila/mensageria;
não repete o que já está em `docs/DECISOES.md` (ADRs) — aqui está o _porquê_ da forma
geral do sistema, lá está o _porquê_ de cada decisão pontual.

## Visão geral: 4 processos, 1 banco, 1 fila

O sistema não é um monólito de um processo só. São **4 processos Node independentes**,
todos lendo/escrevendo no mesmo Postgres, coordenados via Redis (BullMQ) quando
precisam de fila:

| Processo                          | Comando                               | O que faz                                                                                 | Por que é separado                                                                                                                                                                          |
| --------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API HTTP**                      | `npm run dev` / `node dist/server.js` | Serve as 39 rotas REST (auth, devices, políticas, alertas, dashboard...)                  | É o único que precisa responder rápido a humanos — não pode ficar bloqueado processando um evento Pub/Sub demorado                                                                          |
| **Worker Pub/Sub**                | `npm run worker:pubsub`               | Consome a subscription da AMAPI, grava `eventos_brutos`, dispara os handlers de domínio   | Mensageria é _pull_ de longa duração (a conexão fica aberta esperando mensagem) — não combina com o ciclo request/response de uma API HTTP                                                  |
| **Worker de escrita de política** | `npm run worker:policy-write`         | Processa a fila `escrita-politica` (BullMQ), um job por vez                               | A AMAPI tem rate limit por projeto (não por dispositivo) — duas escritas simultâneas de política são uma corrida real, não só risco de estourar quota (ver seção "Fila de política" abaixo) |
| **Worker de manutenção**          | `npm run worker:manutencao`           | A cada `ALERTA_SCAN_INTERVALO_HORAS` (padrão 6h): scan de alertas periódicos + purga LGPD | É uma rotina em lote contra a frota inteira, não algo que uma requisição HTTP dispara                                                                                                       |

Em desenvolvimento, os 4 rodam como processos `tsx` separados na sua máquina. Em
produção, o `docker-compose.yml` só sobe a API (`api`) — os 3 workers precisam de
serviços/processos próprios no ambiente de produção real (ver `docs/OPERACAO.md`).

## Fluxo de um evento, do device até o alerta

Este é o caminho mais importante do sistema — vale entender de cor antes de mexer em
qualquer coisa relacionada a devices/alertas:

```
 Device Android (gerenciado pela AMAPI)
        │ reporta status periodicamente
        ▼
 Google Pub/Sub (subscription pull)
        │
        ▼
 Worker Pub/Sub (src/workers/pubsub-consumer.ts)
        │ 1. grava a mensagem crua em `eventos_brutos`
        │    (idempotente por messageId — nunca perde o dado bruto)
        │ 2. SÓ DEPOIS delega o processamento de domínio
        ▼
 processarEventoBruto (src/domain/eventos/processar-evento.ts)
        │ despacha por `notificationType`, dentro de 1 transação:
        ├─ ENROLLMENT      → cria o dispositivo já vinculado (colaborador/política)
        ├─ STATUS_REPORT   → atualiza dispositivo + apps
        │                     └─ dispara o motor de alertas REATIVO (5 tipos)
        └─ COMMAND         → fecha o ciclo de um comando assíncrono (LOCK/WIPE/...)
        ▼
 ack() só depois do commit da transação
 (se o processo cair no meio, o Pub/Sub reentrega — at-least-once, nunca perde evento)
```

Em paralelo, o **worker de manutenção** varre a frota inteira a cada 6h procurando
**ausência** de algo que nenhum evento reativo detecta sozinho (device que parou de
reportar, linha telefônica nunca vinculada a um device, etc.) — ver seção "Motor de
alertas" abaixo.

Todo esse pipeline é **auditável e reprocessável**: `eventos_brutos` guarda a mensagem
inteira (`{ attributes, data }`, não só o recurso), e `POST /internal/pubsub/replay`
reprocessa manualmente qualquer evento que falhou — usa exatamente o mesmo
`processarEventoBruto` que o consumer em tempo real, então o comportamento é idêntico.

## Banco de dados: 13 tabelas

Schema Drizzle em `src/db/schema/` (um arquivo por domínio), migrations versionadas em
`drizzle/migrations/`. Visão rápida de pra que serve cada tabela:

| Tabela                              | Domínio                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `usuarios`                          | Quem acessa o painel, com `role` (RBAC)                               |
| `refresh_tokens`                    | Sessão — refresh token opaco rotativo (cookie httpOnly)               |
| `colaboradores`                     | Contexto organizacional: quem usa cada device                         |
| `linhas`                            | Linhas telefônicas corporativas, vinculáveis a device ou órfãs        |
| `politicas` / `politicas_versoes`   | Política AMAPI aplicada + histórico (rollback)                        |
| `dispositivos` / `dispositivo_apps` | O device em si + inventário de apps instalados                        |
| `comandos`                          | Histórico de comandos emitidos (LOCK, WIPE, etc.)                     |
| `enrollment_tokens`                 | Token de enrollment emitido, correlacionado no `ENROLLMENT`           |
| `alertas`                           | Os 9 tipos de alerta de compliance — pode apontar pra device OU linha |
| `auditoria`                         | Trilha append-only (login, mudança de role, ações administrativas)    |
| `eventos_brutos`                    | Toda mensagem Pub/Sub recebida, crua, antes de processar              |

Dois detalhes que não são óbvios lendo só o schema:

- `auditoria` é **append-only de verdade** — garantido por um **trigger** de banco, não
  por `REVOKE` (que não bloqueia o dono da tabela — ver ADR-008).
- `alertas.dispositivo_id` é nullable, com um `linha_id` irmão e um `CHECK` garantindo
  exatamente um dos dois preenchido — porque `LINHA_SEM_USO` é um alerta sobre uma linha
  sem device nenhum (ver ADR-027).

## Autenticação e RBAC

Login é **sempre via OIDC** do provedor corporativo — não existe usuário/senha local.
Fluxo: Authorization Code + PKCE → JWT interno de sessão (15 min) → refresh token opaco
rotativo em cookie httpOnly (8h). Reuso de um refresh token já rotacionado é tratado como
sinal de roubo: revoga todas as sessões ativas do usuário, não só rejeita a requisição.

4 papéis (`ADMIN`, `TECNICO`, `VIEWER`, `AUDITOR`), aplicados via `withRole(...)`
(`src/plugins/rbac.ts`) em **toda** rota — há um teste que falha se alguma rota nova
esquecer de declarar `roles`/`public`, garantindo 100% de cobertura do registry. `AUDITOR`
é o papel mais restrito: só enxerga `GET /auditoria`, `GET /alertas` e `GET /dashboard` —
nunca toca em `/devices/*`.

## Integração com a Android Management API (AMAPI)

Toda a comunicação com o Google passa por `src/integrations/amapi/` — **nenhum
controller importa `googleapis` direto**, o que mantém a fronteira de rede isolada e
testável (os testes mockam só esse adapter, nunca a AMAPI inteira).

- `client.ts` — autenticação via service account, cacheada num singleton de módulo (a
  troca de credencial por access token tem custo; `GoogleAuth` renova sozinho quando
  expira).
- `policies.ts`, `devices.ts`, `commands.ts`, `enrollment.ts` — uma função por operação
  real da API (get/list/patch/delete), sempre tipadas contra `androidmanagement_v1`.
- `mappers.ts` — traduz o formato da AMAPI pro schema interno, campo a campo (não um
  formatador genérico de duração — `maximumTimeToLock` é ms sem sufixo, diferente de
  campos `Duration` reais como `'86400s'`; ver ADR-002).
- `retry.ts` — backoff exponencial + jitter em 429/5xx, até 5 tentativas; qualquer outro
  4xx nunca é re-tentado (um erro de validação de payload não se resolve tentando de
  novo).

## Fila de escrita de política: por que é serializada

Este é o ponto mais fácil de entender errado. `concurrency: 1` no worker de
`src/queues/policy-write-queue.ts` **não é** uma escolha conservadora de performance — é
correção. O rate limit da AMAPI é **por projeto Google**, não por dispositivo: dois
admins editando políticas diferentes ao mesmo tempo é uma corrida de verdade contra a
mesma cota, não só um jeito elegante de evitar estourá-la. A fila garante "um de cada
vez, na ordem em que chegou", nunca dois jobs em paralelo — testado contra Redis real,
não só assumido.

A rota HTTP (`POST`/`PATCH /policies`) **espera o resultado da fila antes de responder**
(`executarEscritaPoliticaSincrona`, via `QueueEvents`/`waitUntilFinished`) — do ponto de
vista de quem chama a API, parece síncrono; por trás, é sempre serializado pela fila
(ADR-022). Se a AMAPI recusar o payload, o `POST` desfaz o `INSERT` local — nunca sobra
uma política "fantasma" sem `amapiName` (ADR-023).

## Motor de alertas: reativo vs. periódico

Os 9 tipos de alerta (seção 9 da spec original) se dividem em dois mecanismos bem
diferentes, em `src/domain/alertas/motor.ts`:

- **Reativos (5 tipos)** — `NAO_CONFORME`, `PATCH_DESATUALIZADO`, `SO_OBSOLETO`,
  `STORAGE_CRITICO`, `BATERIA_DEGRADADA`. Checados a cada `STATUS_REPORT` processado,
  na mesma transação — abrem OU resolvem sozinhos, sem scan nenhum. `APP_OBRIGATORIO_AUSENTE`
  (o 9º tipo) segue o mesmo padrão reativo, mas vive em `handlers/status-report.ts` desde
  a Fase 4, não duplicado aqui.
- **Periódicos (3 tipos)** — `SEM_CHECKIN`, `DISPOSITIVO_ORFAO`, `LINHA_SEM_USO`. São
  sobre **ausência** de algo (device que parou de reportar, linha nunca vinculada) —
  nenhum evento reativo detecta isso sozinho, por isso dependem do scan completo da frota
  no `worker:manutencao`.

Todos os limiares (`ALERTA_SEM_CHECKIN_DIAS`, `ALERTA_BATERIA_CRITICA_PCT`, etc.) são env
vars com default, ajustáveis sem redeploy — a spec original nomeia os tipos, não os
números (ADR-031). Esperado que precisem de ajuste fino assim que houver volume real de
uso em produção.

Duas limitações reais da AMAPI valem saber de cor, porque parecem bug e não são:

- `BATERIA_DEGRADADA` mede **carga crítica no momento do check-in**, não degradação
  física da bateria — a AMAPI não expõe saúde/desgaste, só percentual de carga (ADR-029).
- `SO_OBSOLETO` compara a versão "major" do Android via uma tabela SDK→versão, porque a
  AMAPI só expõe a versão "visível ao usuário" (`"13"`), nunca o nível de API/SDK
  diretamente (ADR-030).

## Observabilidade mínima hoje

- Logs estruturados via Pino (`src/shared/logger.ts`), com redaction pré-configurada
  pra nunca vazar segredo em log.
- `GET /health` checa Postgres e Redis de verdade (não só "o processo está de pé").
- O worker de Pub/Sub tem um **watchdog**: se ficar 15 minutos sem processar nenhuma
  mensagem, loga um warning — a AMAPI manda `STATUS_REPORT` periodicamente pra toda a
  frota, silêncio total por muito tempo é sinal de subscription travada ou credencial
  expirada, não "frota parada".
- Não existe ainda métricas/tracing (Prometheus, OpenTelemetry) — ver pendências em
  `docs/OPERACAO.md`.

## Decisões que não são óbvias lendo só o código

Lista curta das que mais afetam quem for mexer no sistema — ADRs completos em
`docs/DECISOES.md`:

- **ADR-015** — `uninstallAppsDisabled` (nível de política) é o mecanismo real de impedir
  desinstalação de app, não o campo por-app `uninstallBlocked` que a spec original citava
  (esse campo não existe no schema atual da AMAPI; mantido mesmo assim, defensivamente).
- **ADR-021** — a suíte de testes roda **serial** (`fileParallelism: false`) de propósito:
  não é falta de memória, é o overhead de orquestração do Testcontainers que fica grande
  demais em paralelo nesta classe de máquina.
- **ADR-026** — localização de device (GPS contínuo) está **fora de escopo** por decisão
  de negócio confirmada, não por limitação técnica esquecida: a AMAPI só oferece isso via
  um recurso "Lost Mode" dedicado, não implementado.

## O que ainda não existe (fora de escopo desta fase)

- Testes E2E reais contra a AMAPI/Pub/Sub de produção (hoje tudo é testado contra mocks
  na fronteira de rede) — bloqueado por enterprise/subscription reais, ver pendências em
  `PROJECT_MEMORY.md`.
- Frontend — este repositório é só backend; a interface é construída por outra equipe a
  partir deste documento + `docs/HANDOFF-FRONTEND.md` + `docs/openapi.json`.
- Métricas/tracing de produção — ver `docs/OPERACAO.md`.
