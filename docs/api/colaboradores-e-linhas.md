# Colaboradores e linhas (`/colaboradores`, `/linhas`)

> Fase 5. Cadastro de contexto organizacional (seção 6) — quem usa cada dispositivo, e a linha
> telefônica associada. Vínculo a um dispositivo específico é feito em `PATCH /devices/:id`
> (ver [devices.md](./devices.md)), não aqui — estas rotas só gerenciam os cadastros em si.

## RBAC

Leitura: `VIEWER`, `TECNICO`, `ADMIN`. Escrita (`POST`/`PATCH`): `TECNICO`, `ADMIN`.
**`AUDITOR` fica de fora dos dois** — extensão da mesma filosofia do ADR-004 (dado
organizacional/operacional, não trilha de auditoria; ver ADR-025).

## `/colaboradores`

```jsonc
// POST — matrícula precisa ser única (409 se já existir)
{ "matricula": "12345", "nome": "Fulano de Tal", "email": "opcional", "filial": "SP", "departamento": "TI", "centroCusto": "opcional" }

// PATCH — tudo opcional, EXCETO matrícula (nunca editável — ver nota abaixo)
{ "departamento": "Financeiro", "ativo": false }
```

`GET /colaboradores` aceita `filial`, `departamento`, `ativo`, `busca` (nome/matrícula/e-mail)
e paginação por cursor.

> **Por que `matricula` não é editável via `PATCH`:** é o identificador natural (índice
> único) — permitir renomear sem tratamento de conflito devolveria um erro de constraint (500)
> em vez de um `409` amigável. Uma matrícula errada se corrige recriando o registro, não
> editando.

## `/linhas`

```jsonc
// POST — número precisa ser único (409 se já existir)
{ "numero": "+5511999990000", "operadora": "texto livre", "iccid": "opcional", "planoDadosGb": 20, "valorMensal": 89.9, "dataAtivacao": "2026-01-01", "observacoes": "opcional" }

// PATCH — tudo opcional, EXCETO número
{ "status": "suspensa", "valorMensal": 0 }
```

`status` é um dos três valores fechados: `ativa`, `suspensa`, `cancelada` (enum de banco — a
própria empresa controla essas transições, não é um valor observado de fora). `operadora`
continua texto livre, sem lista fechada — decisão do Victor (2026-09-04, ADR-005): "todas as
operadoras famosas atualmente, de um modo geral".

`GET /linhas` aceita `status`, `operadora`, `busca` (número/ICCID) e paginação por cursor.

> **`valorMensal` chega e sai como número** no JSON (`89.9`), mas é armazenado como `numeric`
> no Postgres (string internamente, evita imprecisão de ponto flutuante em dinheiro) — a API
> converte nos dois sentidos, não é visível pra quem consome a rota.
