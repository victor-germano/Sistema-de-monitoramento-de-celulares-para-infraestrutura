# Dashboard (`GET /dashboard`)

> Fase 6. Resumo agregado da frota inteira — pensado pra alimentar a tela inicial do painel.
> Contagens, nunca detalhe individual (isso é `/devices`, `/alertas`, etc.).

## `GET /dashboard`

**Papéis:** `VIEWER`, `TECNICO`, `ADMIN` **e `AUDITOR`** — mesma razão de `GET /alertas`
(permissão `compliance:ler`, ADR-028).

**Resposta 200:**

```jsonc
{
  "dispositivos": {
    "total": 342,
    "ativos": 338,
    // Chave "DESCONHECIDO" = dispositivo que nunca mandou STATUS_REPORT ainda.
    "porComplianceState": { "COMPLIANT": 310, "NON_COMPLIANT": 20, "DESCONHECIDO": 12 },
  },
  "alertasAbertos": {
    "total": 47,
    "porTipo": { "SEM_CHECKIN": 12, "STORAGE_CRITICO": 8, "...": "..." },
    "porSeveridade": { "ALTA": 10, "MEDIA": 25, "BAIXA": 12 },
  },
  "colaboradores": { "total": 350, "ativos": 340 },
  "linhas": { "total": 360, "porStatus": { "ativa": 340, "suspensa": 15, "cancelada": 5 } },
}
```

Só contagens agregadas — sem paginação, sem filtro. Pra listas filtráveis/paginadas de
qualquer uma dessas entidades, use as rotas específicas (`GET /devices`, `GET /alertas`,
`GET /colaboradores`, `GET /linhas`).

Exportação em arquivo (CSV/Excel) não está no escopo desta fase — a seção 12 não especifica
um formato; se isso for pedido, é aditivo (um endpoint novo), não uma mudança deste aqui.
