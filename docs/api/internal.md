# Rotas internas (`/internal`)

> Fase 4. Uso operacional — nunca exposto a nenhum papel além de `ADMIN`, e nunca como parte de um fluxo de
> produto normal. Existem pra recuperação manual quando algo dá errado no pipeline de eventos.

## `POST /internal/pubsub/replay`

Reprocessa mensagens já gravadas em `eventos_brutos` (a mensagem Pub/Sub inteira, `{ attributes, data }` —
ver [pubsub-pipeline.md](./pubsub-pipeline.md)) sem precisar de uma mensagem nova chegar na subscription.

**Quando usar:** um handler tinha um bug, foi corrigido, e existem eventos com `erro` preenchido esperando
reprocessamento; ou um `notificationType` passou a ter handler (`sem_handler` antigo) e os eventos antigos
precisam ser processados agora.

```jsonc
// Body — os dois campos são opcionais
{
  "ids": [1, 2, 3], // reprocessa só estes IDs de eventos_brutos, específicos
  "limit": 100, // sem `ids`: pega até `limit` eventos com processado_em = null (padrão 100, máx 500)
}
```

**Resposta 200:**

```jsonc
{
  "totalTentado": 3,
  "processado": 2,
  "semHandler": 0,
  "erro": 1,
  "erros": [{ "id": 3, "mensagem": "STATUS_REPORT: dispositivo ... não encontrado — ..." }],
}
```

Cada evento é reprocessado de forma **idempotente** — os mesmos handlers `ENROLLMENT`/`STATUS_REPORT` do
consumer em tempo real, então reprocessar algo que já deu certo antes não duplica nada. Auditoria
(`PUBSUB_REPLAY`) registra o resumo da chamada.

## `POST /internal/sync/devices`

Reconciliação completa: pagina **todos** os devices que a AMAPI conhece na enterprise e aplica o mesmo
processamento de um `STATUS_REPORT` em cada um. Cobre o caso de mensagens Pub/Sub **perdidas de verdade**
(nunca chegaram a virar `eventos_brutos` — fora do alcance do replay acima), não só atraso.

Sem body. **Resposta 200:**

```jsonc
{ "atualizado": 42, "ignoradoSemEnrollment": 1, "erro": 0 }
```

- `atualizado`: devices já conhecidos aqui (passaram por `ENROLLMENT` antes) — campos e apps atualizados.
- `ignoradoSemEnrollment`: a AMAPI conhece o device, mas ele nunca passou por `ENROLLMENT` neste sistema.
  **Não é criado às cegas** — um dispositivo sem um `enrollment_tokens` de origem quebraria a garantia de
  proveniência conhecida da seção 7. Fica só contado; investigar manualmente por que o `ENROLLMENT` daquele
  device nunca chegou.
- `erro`: falha inesperada reconciliando aquele device específico (logado, não interrompe os demais).

Auditoria (`SYNC_DEVICES_FULL`) registra o resumo.

> **Pode demorar.** Não tem paginação de resposta — a rota só devolve quando processar a frota inteira.
> Rodar via job/CLI administrativo, não a partir de uma tela esperando resposta síncrona.
