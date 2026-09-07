# Pipeline de eventos (Pub/Sub → inventário)

> Fase 4. Não é uma API HTTP — é o processo de fundo (`npm run worker:pubsub`) que mantém `/devices`
> atualizado sozinho. Documentado aqui porque o comportamento observável (o que popula o inventário,
> quando, e o que fazer se algo falhar) é exatamente o que a Fase 4 entrega.

## Visão geral

```
AMAPI ──(evento de device)──▶ Pub/Sub topic ──▶ subscription (pull) ──▶ worker:pubsub
                                                                              │
                                                                              ▼
                                                                    eventos_brutos (idempotente)
                                                                              │
                                                                              ▼
                                                              handler por notificationType
                                                        (ENROLLMENT | STATUS_REPORT | sem handler)
                                                                              │
                                                                              ▼
                                                          dispositivos / dispositivo_apps / alertas
```

- `src/workers/pubsub-consumer.ts` — processo dedicado, roda separado da API HTTP.
- `src/domain/eventos/processar-evento.ts` — núcleo de processamento, compartilhado com o replay manual
  (`POST /internal/pubsub/replay`, ver [internal.md](./internal.md)).
- `src/domain/eventos/handlers/{enrollment,status-report}.ts` — a lógica de cada tipo de evento.

## Formato real da mensagem (ADR-017)

A seção 8 original fala em ler "`notificationType`" sem dizer onde. Confirmado contra a
[documentação oficial do Google](https://developers.google.com/android/management/notifications):

- `notificationType` vem de **`message.attributes`**, não de dentro do JSON de `data`.
- `data` **é o próprio recurso** (`Device`, pros dois tipos que esta fase trata) — não um envelope.
- A notificação de teste (a que o console do Google manda ao configurar a subscription) vem como
  `test`/`TEST` — tratada como no-op (só `ack`, nunca vira `eventos_brutos`).
- Existe `ENTERPRISE_UPGRADE`, que a seção 8 não lista — tratado como "sem handler" (evento gravado, sem
  efeito), igual qualquer tipo que ainda não tem processamento (`COMMAND`, `USAGE_LOGS` — Fase 5+).

`eventos_brutos.payload` grava `{ attributes, data }` **juntos** — a mensagem inteira, não só o recurso —
pra o replay poder reprocessar sem ter perdido nenhuma informação da mensagem original.

## `ENROLLMENT` — como um device novo entra no inventário

**Critério de aceite da fase:** um enrollment de device de teste popula o banco com o vínculo correto,
sozinho — sem nenhuma ação manual depois.

1. Na criação do QR code (`POST /enrollment/tokens`, seção 10), o `tokenId` (nosso UUID de
   `enrollment_tokens`) é gravado como `additionalData` do token na AMAPI.
2. Quando o device escaneia o QR e completa o provisionamento, a AMAPI manda `ENROLLMENT` com
   `Device.enrollmentTokenData` = exatamente aquele `additionalData`.
3. O handler lê o `tokenId` dali, busca a linha em `enrollment_tokens`, cria o dispositivo já com
   colaborador/patrimônio/política vinculados (prioriza o que veio no `additionalData` no momento da
   criação do token; cai pro que já estava na própria linha de `enrollment_tokens` senão), e marca o
   token como usado.
4. Idempotente: reprocessar o mesmo device (redelivery — Pub/Sub é _at-least-once_) não duplica nada.

## `STATUS_REPORT` — atualização periódica

Dispositivo já cadastrado reportando o estado atual: campos como versão do Android, patch de segurança,
compliance, bateria, storage, apps instalados. Nunca cria um dispositivo — se o device ainda não passou por
`ENROLLMENT` aqui, o evento vira erro (`DispositivoDesconhecidoError`, fica registrado com `erro` em
`eventos_brutos` pra investigar/reprocessar depois).

Junto da atualização, verifica se algum app marcado `FORCE_INSTALLED` na política do dispositivo não está
entre os apps reportados — se faltar, abre o alerta `APP_OBRIGATORIO_AUSENTE` (idempotente: um alerta aberto
por dispositivo+tipo, não duplica em `STATUS_REPORT`s consecutivos com o mesmo app faltando).

## Discrepâncias conhecidas entre a AMAPI e a seção 6 (ADR-019)

- **`compliance_state`** não existe como campo — é derivado de `policyCompliant` (`true`→`COMPLIANT`,
  `false`→`NON_COMPLIANT`, ausente→desconhecido).
- **Bateria/storage livre** não são campos estáticos — são o evento mais recente de
  `powerManagementEvents`/`memoryEvents`. O filtro de storage usa "`eventType` contém STORAGE" (tolerante),
  não um literal exato — os valores exatos do enum não puderam ser confirmados na documentação disponível.
  **Pendente validar contra um device real** assim que a enterprise deixar de ser placeholder (ADR-005).
- **`installType`** em `dispositivo_apps` fica sempre vazio quando vem de `STATUS_REPORT` — é atributo de
  política, não do relatório observado do device.

## Falhas e recuperação

- **Erro no handler:** a transação do evento é revertida (nada de domínio fica gravado), mas
  `eventos_brutos.erro` é preenchido fora dela — o evento cru nunca se perde. A mensagem recebe `nack()`
  (Pub/Sub reentrega) — mas se o erro for determinístico (ex.: device nunca enrollado), reentregas repetidas
  não resolvem sozinhas; use `POST /internal/pubsub/replay` depois de corrigir a causa.
- **Payload que não é JSON válido:** `ack()` direto — reenviar não conserta um JSON quebrado; fica só no log.
- **Watchdog:** se nenhuma mensagem for processada em 15 minutos, um aviso é logado — a AMAPI manda
  `STATUS_REPORT` periodicamente pra toda a frota, então silêncio total por muito tempo é sinal de
  subscription travada/credencial expirada, não "frota parada".
