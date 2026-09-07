# Dispositivos (`/devices`)

> Fase 4. Consumido pela equipe de frontend — este documento é o contrato, não o código.
> Schemas completos (Zod → OpenAPI) também ficam navegáveis em `/docs` (Swagger UI) quando a API sobe.

## Visão geral

Inventário de dispositivos corporativos, populado automaticamente pelos handlers `ENROLLMENT`/`STATUS_REPORT`
do consumer Pub/Sub (ver [pubsub-pipeline.md](./pubsub-pipeline.md)) — nenhuma rota aqui **cria** um dispositivo.
`PATCH /devices/:id` só altera o vínculo administrativo (colaborador, linha, patrimônio, ativo); não toca a AMAPI.

Papéis de leitura (`GET *`): `VIEWER`, `TECNICO`, `ADMIN`. Escrita (`PATCH`): só `TECNICO` e `ADMIN`.

> **`AUDITOR` não acessa nenhuma rota sob `/devices/*`, nem as de leitura** (ADR-004, confirmado com o
> Victor em 2026-09-04) — inclusive `GET /devices/:id/auditoria` abaixo. O único acesso desse papel à
> trilha de auditoria é o endpoint global `GET /auditoria`, documentado em
> [`auditoria.md`](./auditoria.md).

## Endpoints

### `GET /devices`

Lista paginada por **cursor** (nunca offset — seção 11), com filtros todos opcionais e combináveis.

| Query param       | Tipo                      | Efeito                                                                |
| ----------------- | ------------------------- | --------------------------------------------------------------------- |
| `filial`          | string                    | Filtra pela filial do colaborador vinculado                           |
| `departamento`    | string                    | Filtra pelo departamento do colaborador vinculado                     |
| `complianceState` | string                    | `COMPLIANT` / `NON_COMPLIANT` (ver nota sobre origem do valor abaixo) |
| `politicaId`      | uuid                      | Dispositivos usando esta política                                     |
| `colaboradorId`   | uuid                      | Dispositivos de um colaborador específico                             |
| `busca`           | string                    | Texto livre — casa contra patrimônio, IMEI, serial e modelo (`ILIKE`) |
| `semCheckinDias`  | inteiro > 0               | Só dispositivos sem `STATUS_REPORT` há N dias (ou nunca reportaram)   |
| `limit`           | inteiro 1–100 (padrão 25) | Tamanho da página                                                     |
| `cursor`          | uuid                      | `proximoCursor` da página anterior                                    |

**Resposta 200:**

```jsonc
{
  "itens": [
    {
      "id": "uuid",
      "amapiName": "enterprises/.../devices/...",
      "imei": "...",
      "serial": "...",
      "patrimonio": "...",
      "fabricante": "...",
      "modelo": "...",
      "versaoSo": "...",
      "estado": "ACTIVE", // valor bruto da AMAPI — ver ADR-007
      "complianceState": "COMPLIANT", // derivado de policyCompliant — ver ADR-019
      "policyCompliant": true,
      "bateriaPct": 82,
      "storageTotalMb": 65536,
      "storageLivreMb": 12000,
      "ultimoCheckin": "2026-09-05T10:00:00Z",
      "colaboradorId": "uuid",
      "colaboradorNome": "Nome do colaborador",
      "linhaId": "uuid",
      "politicaId": "uuid",
      "ativo": true,
      "criadoEm": "...",
      "atualizadoEm": "...",
    },
  ],
  "proximoCursor": "uuid ou omitido quando não há próxima página",
}
```

### `GET /devices/:id`

Um dispositivo por `id` (nosso UUID, não o `amapiName`). `404` se não existir.

### `PATCH /devices/:id`

Body — todos os campos opcionais, só os enviados são alterados:

```jsonc
{
  "colaboradorId": "uuid | null",
  "linhaId": "uuid | null",
  "patrimonio": "string | null",
  "ativo": true,
}
```

Grava auditoria (`DISPOSITIVO_VINCULO_ALTERADO`, visível em `GET /devices/:id/auditoria`). `404` se o dispositivo não existir.

> **Nota sobre `ativo`:** é só uma sinalização nossa (ADR-018) — desativar aqui **não** desprovisiona nem revoga
> nada na AMAPI. Isso continua exigindo uma ação explícita (comando de wipe — ver [comandos.md](./comandos.md)).

### `GET /devices/:id/apps`

Lista de apps observados no dispositivo (última leitura de `STATUS_REPORT`). Vazio até o primeiro `STATUS_REPORT`
chegar. `installType` fica sempre vazio aqui — ver nota abaixo.

```jsonc
[
  {
    "packageName": "com.empresa.app",
    "nomeExibicao": "...",
    "versao": "...",
    "estado": "INSTALLED",
    "coletadoEm": "...",
  },
]
```

> **Por que `installType` nunca vem preenchido:** é um atributo de **política** (o que queremos instalado), não do
> relatório do device (o que está instalado). Ver ADR-019.

### `GET /devices/:id/comandos`

Histórico de comandos emitidos para o dispositivo (mais recente primeiro). Aceita `?limit=`
(1–200, padrão 50). Emissão (`POST`) documentada separado em [comandos.md](./comandos.md).

### `GET /devices/:id/auditoria`

Histórico de ações administrativas sobre o dispositivo (hoje, só `DISPOSITIVO_VINCULO_ALTERADO`). Aceita `?limit=`
(1–200, padrão 50).

## Erros

Formato RFC 9457 (`application/problem+json`) em toda resposta de erro — `401` sem token, `403` papel sem
permissão, `404` id inexistente, `400` querystring/body fora do schema.
