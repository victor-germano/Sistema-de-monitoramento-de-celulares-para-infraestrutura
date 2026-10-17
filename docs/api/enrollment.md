# Enrollment (`/enrollment/tokens`)

> Fecha o gap da seção 10 que `docs/SETUP.md` e `docs/HANDOFF-FRONTEND.md` registravam —
> "adicionar um dispositivo novo" via QR code. O adapter da AMAPI
> (`src/integrations/amapi/enrollment.ts`) e o processamento do evento `ENROLLMENT` (Fase 4,
> ver [pubsub-pipeline.md](./pubsub-pipeline.md)) já existiam prontos; esta rota é só a
> camada HTTP que faltava pra alguém conseguir criar um token sem mexer no banco na mão.

## `POST /enrollment/tokens` (`TECNICO`/`ADMIN`)

```jsonc
{ "politicaId": "uuid", "patrimonio": "PAT-00123", "colaboradorId": "uuid" } // os dois últimos são opcionais
```

Resposta `201` — a linha criada **mais `valor` e `qrCode` em texto puro, só desta vez**:

```jsonc
{
  "id": "uuid",
  "amapiTokenName": "enterprises/.../enrollmentTokens/...",
  "politicaId": "uuid",
  "patrimonio": "PAT-00123",
  "colaboradorId": "uuid",
  "expiraEm": "2026-10-16T18:00:00.000Z",
  "usadoEm": null,
  "dispositivoId": null,
  "criadoPor": "uuid",
  "valor": "...", // nunca mais recuperável — só o hash fica persistido
  "qrCode": "{...}", // JSON pra gerar a imagem do QR code (não vem como imagem pronta)
}
```

`valor`/`qrCode` nunca aparecem em nenhuma consulta posterior (`GET`), mesma regra do
refresh token (ver `src/domain/auth/refresh-tokens.ts`) — só o hash (`valorHash`) fica no
banco. Perdeu antes de copiar/escanear? Revoga (`DELETE`) e cria outro.

**Erros:** `404` política ou colaborador inexistente · `422` política sem `amapiName`
(não deveria acontecer — toda política nasce com um, ver `politicas.md`) · `502` falha da
AMAPI (inclusive por falta de credencial configurada — esperado até a enterprise AMAPI
real ser confirmada, ver `PROJECT_MEMORY.md`).

## `GET /enrollment/tokens` (qualquer papel autenticado)

Paginado (`itens`/`proximoCursor`, cursor por `id`), filtrável por `usado` (`true`/`false`).
Nunca devolve `valor`/`qrCode` — só os metadados da linha.

## `DELETE /enrollment/tokens/:id` (`TECNICO`/`ADMIN`)

Revoga na AMAPI (best-effort — um token de 1h que já expirou sozinho não bloqueia a
limpeza) e remove a linha. `404` se não existir · `409` se já foi usado pra provisionar um
device (`usadoEm` preenchido) — nesse caso o registro fica, é histórico de provisionamento,
não um token pendente.

## O que acontece depois que o device escaneia

Isso já existia desde a Fase 4, nenhuma mudança aqui: o device reporta `ENROLLMENT` via
Pub/Sub, o worker correlaciona pelo `tokenId` dentro do `additionalData` que a própria
AMAPI ecoa de volta, marca `usadoEm` (atômico, `WHERE usado_em IS NULL` — primeira
reivindicação ganha mesmo com redelivery concorrente) e cria o dispositivo já vinculado à
política/patrimônio/colaborador do token. Ver [pubsub-pipeline.md](./pubsub-pipeline.md).

## Gerar a imagem do QR code de verdade

`qrCode` é a string JSON que o conteúdo do QR precisa carregar, não uma imagem — o
frontend hoje mostra esse texto cru (pra colar num gerador externo) em vez de renderizar a
imagem, pra não adicionar uma dependência de geração de QR só por isso. Se quiser a imagem
na própria tela, qualquer biblioteca cliente de QR (ex. `qrcode`) resolve, dado que o
conteúdo (`qrCode`) já vem pronto da API.
