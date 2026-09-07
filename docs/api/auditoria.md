# Auditoria (`GET /auditoria`)

> Fase 4. Trilha de auditoria é **append-only** desde a Fase 2 (ADR-008) — este é o primeiro endpoint de
> leitura sobre ela.

## Por que existe separado de `/devices/:id/auditoria`

A seção 5 diz que o papel `AUDITOR` "não vê inventário operacional nem executa ação", mas a seção 10 lista
`GET /devices/:id/auditoria` sem excluir esse papel explicitamente. **Decisão confirmada com o Victor em
2026-09-04 (ADR-004): `AUDITOR` não acessa nenhuma rota sob `/devices/*`, nem as de leitura.**

Consequência prática: existem **duas rotas que leem a mesma tabela**, com papéis diferentes:

| Rota                         | Papéis                       | Uso                                                                                                                |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /devices/:id/auditoria` | `VIEWER`, `TECNICO`, `ADMIN` | Histórico de UM dispositivo, no contexto de quem já está vendo aquele dispositivo (ver [devices.md](./devices.md)) |
| `GET /auditoria` (este)      | `ADMIN`, `AUDITOR`           | Visão global — é o único jeito do `AUDITOR` enxergar qualquer coisa neste sistema                                  |

## `GET /auditoria`

Paginado por cursor (`id`, nunca offset — seção 11), mais recente primeiro.

| Query param  | Tipo                      | Efeito                                                                                                    |
| ------------ | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `entidade`   | string                    | Ex.: `dispositivo`, `usuario`, `eventos_brutos`                                                           |
| `entidadeId` | string                    | Restringe a UMA entidade específica (equivalente ao endpoint por-dispositivo, mas acessível ao `AUDITOR`) |
| `limit`      | inteiro 1–200 (padrão 50) | Tamanho da página                                                                                         |
| `cursor`     | inteiro                   | `proximoCursor` da página anterior                                                                        |

**Resposta 200:**

```jsonc
{
  "itens": [
    {
      "id": 123,
      "atorId": "uuid ou null (ação do próprio sistema)",
      "atorEmail": "...",
      "acao": "DISPOSITIVO_VINCULO_ALTERADO",
      "entidade": "dispositivo",
      "entidadeId": "uuid",
      "detalhes": { "...": "..." },
      "ip": "...",
      "userAgent": "...",
      "ocorridoEm": "2026-09-05T10:00:00Z",
    },
  ],
  "proximoCursor": 100,
}
```

Sem filtro nenhum, devolve a trilha inteira do sistema (paginada) — é a "visão global" que a seção 5
descreve como o motivo de existir do papel `AUDITOR`.
