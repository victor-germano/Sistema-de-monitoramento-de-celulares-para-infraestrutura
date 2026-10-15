# Dashboard (`GET /dashboard`, `GET /dashboard/export`)

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

## `GET /dashboard/export`

**Papéis:** os mesmos de `GET /dashboard` (`VIEWER`, `TECNICO`, `ADMIN`, `AUDITOR`).

Mesmo dado de `GET /dashboard`, em planilha `.xlsx` (`Content-Type:
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, com
`Content-Disposition: attachment; filename="dashboard-mdm-AAAA-MM-DD.xlsx"`). Pensado pra
quem quer levar o número pra uma reunião/planilha — não substitui o `GET /dashboard` JSON
como fonte pra uma tela viva (sem paginação nem filtro, igual ao endpoint original).

Abas geradas: `Resumo` (totais), `Dispositivos por conformidade`, `Alertas por tipo`,
`Alertas por severidade`, `Linhas por status` — ver `src/domain/dashboard/exportar-excel.ts`.
