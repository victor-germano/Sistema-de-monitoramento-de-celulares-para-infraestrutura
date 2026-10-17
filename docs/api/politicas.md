# Políticas (`/policies`)

> Fase 5. CRUD completo em cima do adapter e da fila serializada que a Fase 3 já deixou
> prontos como biblioteca interna — esta fase é quem finalmente os conecta a uma rota HTTP.

## Visão geral

Uma política aqui é sempre um payload `Policy` da AMAPI (seção 7) mais o histórico completo de
versões. Toda escrita (`POST`/`PATCH`/rollback) passa pelos mesmos três passos, sempre:

1. **`enforceInvariants`** corrige o payload (força `uninstallAppsDisabled: true` e o resto dos
   invariantes da seção 3) — nunca é opcional, nunca tem bypass, nem pra `ADMIN`. Se algo foi
   corrigido, uma entrada de auditoria `POLITICA_INVARIANT_OVERRIDE` registra o que mudou.
2. **Enfileirado** na fila serializada (concorrência 1 — nunca duas escritas de política ao
   mesmo tempo contra a AMAPI) e **aguardado** — a rota só responde depois do resultado real
   (sucesso com o payload final, ou erro da AMAPI).
3. **Gravado** localmente: `politicas.payload`/`versao` atualizados, uma linha nova em
   `politicas_versoes` (nunca sobrescreve uma versão antiga).

**Só `ADMIN` escreve** (`POST`/`PATCH`/`DELETE`/rollback). Leitura: `VIEWER`, `TECNICO`,
`ADMIN` — `AUDITOR` fica de fora, mesma filosofia do ADR-004.

> **Requer o worker de pé.** `npm run worker:policy-write` precisa estar rodando — é ele quem
> processa a fila e de fato chama a AMAPI. Sem ele, toda escrita expira em 30s e devolve 502.

## Endpoints

### `GET /policies`

Paginado por cursor (`itens`/`proximoCursor`, `limit`/`cursor` — mesmo padrão de
`docs/HANDOFF-FRONTEND.md` seção 3), filtros opcionais: `busca` por nome, `ativa`
true/false. Ordenado por `id` (ordem de criação), não mais por `nome` — fechado
numa sessão posterior à Fase 5, pra bater com o padrão de cursor que toda outra
lista já seguia.

### `GET /policies/:id`

Uma política, com o payload atual completo.

### `GET /policies/:id/versoes`

Histórico completo, mais recente primeiro — nunca é apagado, mesmo depois de um rollback ou de
a política ser desativada.

### `POST /policies`

```jsonc
{ "nome": "operacao-campo-2", "descricao": "opcional", "payload": { "applications": [] } }
```

`nome` precisa ser único (409 se já existir). O nome do recurso na AMAPI é sempre
`enterprises/<id>/policies/<uuid-local>` — o próprio UUID da política local vira o `policyId`
do lado da AMAPI, sem precisar de um passo de "reservar nome" antes de existir aqui.

Se a AMAPI recusar o payload, a rota devolve `502` e **não deixa nenhuma linha órfã** no nosso
banco — a criação local é desfeita (ADR-023).

### `PATCH /policies/:id`

```jsonc
// Só metadados — não cria versão nova, não toca a AMAPI
{ "descricao": "nova descrição", "ativa": true }

// Com payload — cria uma versão NOVA e envia pra AMAPI
{ "payload": { "applications": [{ "packageName": "com.empresa.app", "installType": "FORCE_INSTALLED" }] } }
```

### `POST /policies/:id/rollback`

```jsonc
{ "versao": 3 }
```

Restaura o payload da versão indicada — como uma versão **nova** (nunca reescreve a antiga).
Passa por `enforceInvariants` de novo: uma versão antiga já gravada pode não respeitar
invariantes que só passaram a existir depois.

### `DELETE /policies/:id`

Soft — marca `ativa: false`, nunca apaga a linha (preservaria `politicas_versoes` órfão).
`409` se algum dispositivo ainda usa a política (reatribua-os primeiro). Tenta remover o
recurso da AMAPI só quando seguro (best-effort — uma falha aqui não impede a desativação
local, só fica no log).

## Erros

`403` papel sem permissão · `404` id/versão inexistente · `409` nome/uso em conflito ·
`422` política sem `amapiName` (nunca foi enviada pra AMAPI de verdade) · `502` a AMAPI
recusou o payload.
