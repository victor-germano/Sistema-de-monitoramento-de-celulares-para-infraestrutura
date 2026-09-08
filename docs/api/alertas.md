# Alertas (`/alertas`)

> Fase 6. Os 9 tipos da seção 9. Abertura é sempre automática — estas rotas só leem e permitem
> reconhecer/resolver manualmente.

## Como cada tipo é detectado

| Tipo                      | Mecanismo                                | Severidade | Limiar (env var)                                    |
| ------------------------- | ---------------------------------------- | ---------- | --------------------------------------------------- |
| `APP_OBRIGATORIO_AUSENTE` | Reativo, a cada `STATUS_REPORT` (Fase 4) | MEDIA      | —                                                   |
| `NAO_CONFORME`            | Reativo                                  | ALTA       | — (`policyCompliant` da AMAPI)                      |
| `PATCH_DESATUALIZADO`     | Reativo                                  | MEDIA      | `ALERTA_PATCH_MAX_DIAS` (90)                        |
| `SO_OBSOLETO`             | Reativo                                  | MEDIA      | `ANDROID_VERSAO_MINIMA_SDK` (30 → Android 11)       |
| `STORAGE_CRITICO`         | Reativo                                  | ALTA       | `ALERTA_STORAGE_CRITICO_MB` (500)                   |
| `BATERIA_DEGRADADA`       | Reativo                                  | BAIXA      | `ALERTA_BATERIA_CRITICA_PCT` (15) — ver nota abaixo |
| `SEM_CHECKIN`             | Periódico (scan)                         | MEDIA      | `ALERTA_SEM_CHECKIN_DIAS` (3)                       |
| `DISPOSITIVO_ORFAO`       | Periódico (scan)                         | BAIXA      | `ALERTA_DISPOSITIVO_ORFAO_DIAS` (7)                 |
| `LINHA_SEM_USO`           | Periódico (scan)                         | BAIXA      | —                                                   |

**Reativo** = calculado de novo a cada `STATUS_REPORT` processado (dentro de
`processarStatusReport`) — abre OU resolve, sempre os dois lados. **Periódico** = um scan
completo da frota, rodado pelo `npm run worker:manutencao` a cada `ALERTA_SCAN_INTERVALO_HORAS`
(default 6h) — cobre os 3 tipos sobre AUSÊNCIA de algo, que nenhum evento reativo detecta
sozinho.

> **`BATERIA_DEGRADADA` não mede degradação física da bateria.** A AMAPI só relata percentual
> de carga no momento do check-in, não saúde/desgaste da bateria (esse dado não existe no
> schema da AMAPI). O que este alerta na verdade sinaliza é "bateria criticamente baixa no
> último check-in" — ver ADR-029.

> **`LINHA_SEM_USO` é o único tipo sem `dispositivoId`** — ele é sobre uma linha ativa sem
> nenhum dispositivo usando ela, então a resposta traz `linhaId` preenchido e `dispositivoId:
null` (ver ADR-027).

## Endpoints

### `GET /alertas`

| Query param      | Efeito                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `dispositivoId`  | Só alertas de um dispositivo                                                             |
| `tipo`           | Um dos 9 tipos acima                                                                     |
| `severidade`     | `ALTA` \| `MEDIA` \| `BAIXA`                                                             |
| `aberto`         | `true` = só abertos (padrão de uso mais comum), `false` = só resolvidos, ausente = todos |
| `limit`/`cursor` | Paginação por cursor (seção 11)                                                          |

**Papéis:** `VIEWER`, `TECNICO`, `ADMIN` **e `AUDITOR`** — diferente de `/devices/*`, este papel
tem acesso aqui porque a permissão `compliance:ler` (seção 5, desde a Fase 2) é exatamente
sobre isso (ADR-028).

### `GET /alertas/:id`

Um alerta específico, mesmos papéis de leitura acima.

### `POST /alertas/:id/reconhecer`

Registra `reconhecidoPor`/`reconhecidoEm` — não fecha o alerta, só marca que alguém viu.
`TECNICO`/`ADMIN` (não `AUDITOR` — reconhecer é ação operacional, ler é o que a permissão de
compliance cobre).

### `POST /alertas/:id/resolver`

Fecha manualmente (`resolvidoEm`) — para quando a correção foi feita fora do sistema (ex.:
trocou a bateria do device fisicamente) e o próximo `STATUS_REPORT`/scan ainda não confirmou
isso sozinho. `TECNICO`/`ADMIN`.

## Disparo manual do scan periódico

`POST /internal/pubsub/replay`-style: `POST /internal/alertas/verificar` (`ADMIN`) roda os 3
scans periódicos na hora, sem esperar o próximo ciclo do `worker:manutencao` — ver
[internal.md](./internal.md).
