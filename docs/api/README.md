# Documentação de API — por tópico

Um markdown por assunto, pensado pra quem vai construir a interface (ou integrar com esta API) sem
precisar ler o código. Contrato exato de request/response (schemas Zod → OpenAPI) fica navegável em
`/docs` (Swagger UI) com a API no ar; estes documentos explicam o **comportamento** por trás de cada rota
— o que dispara o quê, o que é derivado vs. bruto, e o que ainda não existe.

| Tópico                                       | Cobre                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`pubsub-pipeline.md`](./pubsub-pipeline.md) | Como o inventário se popula sozinho: consumer Pub/Sub, `ENROLLMENT`/`STATUS_REPORT`, `eventos_brutos`, recuperação de falha |
| [`devices.md`](./devices.md)                 | `/devices` — listagem, detalhe, vínculo administrativo, apps/comandos/auditoria por dispositivo                             |
| [`internal.md`](./internal.md)               | `/internal` — replay de eventos e reconciliação completa contra a AMAPI (só `ADMIN`)                                        |
| [`auditoria.md`](./auditoria.md)             | `GET /auditoria` — visão global da trilha de auditoria; único acesso do papel `AUDITOR` (ADR-004)                           |

Cada fase nova adiciona os tópicos que introduziu — não é um documento por rota, é um documento por
**assunto** (às vezes várias rotas relacionadas, como em `devices.md`).
