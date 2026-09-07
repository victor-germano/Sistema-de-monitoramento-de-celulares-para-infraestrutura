# Comandos (`POST /devices/:id/comandos`)

> Fase 5. Emissão de verdade contra a AMAPI — a Fase 4 só tinha o `GET` (histórico). Ver
> [devices.md](./devices.md) pro resto das rotas de dispositivo.

## Tipos de comando e quem pode emitir

| `tipo`                 | Papel mínimo | Campos extra                                     |
| ---------------------- | ------------ | ------------------------------------------------ |
| `LOCK`                 | `TECNICO`    | —                                                |
| `REBOOT`               | `TECNICO`    | —                                                |
| `RESET_PASSWORD`       | `TECNICO`    | `novaSenha` (opcional)                           |
| `CLEAR_APP_DATA`       | `TECNICO`    | `pacotes` (obrigatório, lista de package names)  |
| `RELINQUISH_OWNERSHIP` | `ADMIN`      | — (gap da spec — ADR-025: mesmo nível de `WIPE`) |
| `WIPE`                 | `ADMIN`      | `patrimonioConfirmacao` + `motivo` (≥ 20 chars)  |

```jsonc
// LOCK/REBOOT/RELINQUISH_OWNERSHIP
{ "tipo": "LOCK" }

// RESET_PASSWORD
{ "tipo": "RESET_PASSWORD", "novaSenha": "opcional" }

// CLEAR_APP_DATA
{ "tipo": "CLEAR_APP_DATA", "pacotes": ["com.empresa.app"] }

// WIPE — dupla confirmação obrigatória
{ "tipo": "WIPE", "patrimonioConfirmacao": "PAT-00123", "motivo": "device extraviado, aberto B.O. nº..." }
```

`patrimonioConfirmacao` precisa bater **exatamente** com `dispositivos.patrimonio` — errar
devolve `422`, não silenciosamente ignora.

## O que acontece depois de emitido

- **`WIPE`**: síncrono — é um `devices.delete` (AMAPI), não um `issueCommand`. A resposta já
  vem com `status: "SUCESSO"` (ou `"FALHA"` com o erro, se a AMAPI recusar).
- **Todos os outros**: `issueCommand` devolve uma `Operation` assíncrona — o comando nasce
  `status: "ENVIADO"`, com `amapiOperationName` gravado. O resultado FINAL (sucesso ou falha)
  só chega depois, via evento `COMMAND` do Pub/Sub (ver
  [pubsub-pipeline.md](./pubsub-pipeline.md)) — o handler correlaciona pelo
  `amapiOperationName` e atualiza `status`/`erro`/`concluidoEm`. Consulte
  `GET /devices/:id/comandos` depois pra ver o resultado.

## O que nunca aparece no histórico

`novaSenha` (RESET_PASSWORD) e `patrimonioConfirmacao` (WIPE) nunca são persistidos em
`comandos.payload` — o histórico (visível via `GET /devices/:id/comandos` pra `VIEWER`/
`TECNICO`/`ADMIN`) guarda só o necessário pra contexto (`pacotes`, `motivo`), nunca segredo ou
dado de confirmação (ADR-024).

## Rate limit

Além do limite global da API, esta rota tem um limite adicional (seção 11): **10 requisições
por minuto** — evita um script/bug disparando comandos em loop contra a frota inteira.
