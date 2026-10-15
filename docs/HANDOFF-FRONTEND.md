# Handoff para o time de frontend

Este documento é o ponto de partida para quem vai construir a interface deste
backend **sem precisar ler o código**. Pressupõe zero conhecimento prévio do projeto.

**Contrato formal de cada rota** (schema exato de request/response, todos os campos,
todos os status code possíveis) está em [`docs/openapi.json`](./openapi.json) — importe
esse arquivo no Postman/Insomnia, ou gere um client TypeScript a partir dele (ex.:
`openapi-typescript`). Com a API no ar, o mesmo contrato também é navegável em
`http://localhost:13000/docs` (Swagger UI). **Este documento explica o fluxo e o
comportamento por trás das rotas — o `openapi.json` é a fonte de verdade do formato
exato de cada campo.**

Documentação complementar, uma por assunto, em [`docs/api/`](./api/README.md) —
`devices.md`, `politicas.md`, `comandos.md`, `alertas.md`, `dashboard.md`, etc.

## 1. Autenticação — leia isto antes de qualquer outra rota

Não existe usuário/senha deste sistema. Login é sempre via **OIDC corporativo**
(Google Workspace do Grupo Roveri). O fluxo completo, passo a passo:

```text
1. Frontend redireciona o browser para GET /auth/login
   (não é uma chamada fetch/AJAX — é navegação real do browser, tipo <a href>)

2. API redireciona para a tela de login do Google

3. Usuário faz login → Google redireciona para GET /auth/callback (a própria API)

4. API valida tudo, seta um cookie httpOnly chamado `mdm_refresh_token`
   e redireciona o browser para FRONTEND_URL (a URL da SUA aplicação)

5. Sua aplicação carrega. PRIMEIRA COISA que ela faz: POST /auth/refresh
   (o cookie já está presente no browser, vai junto automaticamente —
   sua chamada fetch só precisa de `credentials: 'include'`)

6. Resposta: { "accessToken": "<jwt>", "expiresIn": 900 }
   Guarde esse accessToken em memória (NUNCA em localStorage — é um JWT
   de 15 minutos, não precisa sobreviver a um refresh de página)

7. Toda chamada daqui pra frente leva o header:
   Authorization: Bearer <accessToken>

8. Quando o accessToken expirar (15 min) ou uma chamada voltar 401:
   chame POST /auth/refresh de novo (mesmo cookie, ainda válido por 8h)
   para pegar um accessToken novo — sem precisar repetir o login inteiro

9. Logout: POST /auth/logout (limpa o cookie no servidor e no browser)
```

**Por que não dá pra simplificar isso:** o cookie (`mdm_refresh_token`) é o único jeito
de manter sessão sem guardar token de longa duração em lugar acessível a JavaScript —
se o site tiver uma falha de XSS, um token em `localStorage` seria roubável; um cookie
`httpOnly` não é. O preço disso é esse passo extra no boot da aplicação (chamar
`/auth/refresh` antes de qualquer outra coisa).

### `GET /auth/me` — descobrir quem é o usuário logado e o que ele pode fazer

Depois de ter o `accessToken`, chame `GET /auth/me` para saber o nome, e-mail, `role` e
a lista de permissões do usuário — é basicamente o que a tela usa para decidir o que
mostrar/esconder (ex.: esconder o botão de `WIPE` se o usuário não for `ADMIN`).

### Os 4 papéis (roles) e o que cada um vê

| Role      | Pode fazer                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `VIEWER`  | Só leitura — listar devices, políticas, alertas, dashboard                                                                          |
| `TECNICO` | Tudo do `VIEWER` + emitir comandos (exceto `WIPE`/`RELINQUISH_OWNERSHIP`), editar vínculo de device, CRUD de colaboradores/linhas   |
| `ADMIN`   | Tudo, incluindo `WIPE`, `RELINQUISH_OWNERSHIP`, CRUD de políticas, gestão de usuários/roles                                         |
| `AUDITOR` | **Só** `GET /auditoria`, `GET /alertas`, `GET /dashboard` — não enxerga `/devices/*` nem `/colaboradores/*` nem nada administrativo |

Trate `403 Forbidden` como "o usuário está logado mas não pode fazer isso" (esconda o
botão/ação, não é um erro para mostrar numa tela de erro genérica) e `401 Unauthorized`
como "sessão expirada, tente `/auth/refresh`, senão mande pro login de novo".

## 2. Formato de erro — sempre o mesmo em toda rota

Todo erro (400, 401, 403, 404, 422, 429, 500) vem no formato RFC 9457
(`Content-Type: application/problem+json`):

```json
{
  "type": "https://docs.internal.gruporoveri.com.br/mdm/erros/422",
  "title": "Não é possível remover o último ADMIN",
  "status": 422,
  "detail": "Promova outro usuário a ADMIN antes de rebaixar este."
}
```

- `title` é o resumo (bom para um toast de erro genérico).
- `detail`, quando presente, é a explicação específica daquele caso — mostre ao
  usuário quando fizer sentido (ex.: o exemplo acima é um erro de validação de
  negócio que o usuário pode resolver mudando a ação).
- Erro de validação de campo (400, corpo/query mal formado) populam `detail` com a
  mensagem do Zod — útil para apontar qual campo está errado durante o
  desenvolvimento, mas não é um formato estruturado campo-a-campo (não espere um
  array de erros por campo).

## 3. Paginação — mesmo padrão em toda lista

Toda rota de listagem (`GET /devices`, `GET /colaboradores`, `GET /linhas`,
`GET /policies`, `GET /alertas`, etc.) usa **cursor**, não número de página:

**Request:** `GET /devices?limit=25` (primeira página) depois
`GET /devices?limit=25&cursor=<proximoCursor-da-resposta-anterior>` (próxima página)

**Response:**

```json
{
  "itens": [/* array de devices */],
  "proximoCursor": "018f2a3e-...-uuid"
}
```

Quando `proximoCursor` vier `null`/ausente, não há mais página — pare de mostrar o
botão "carregar mais"/infinite scroll. `limit` máximo é 100 (seção padrão em todas as
rotas, salvo alguma exceção documentada em `docs/api/`).

## 4. Rate limits — a tela precisa tratar 429

- **Global:** 100 requisições/minuto por conexão, em toda rota.
- **`POST /devices/:id/comandos`:** limite extra de 10/minuto — se o usuário clicar em
  "bloquear aparelho" repetidamente numa tela de muitos devices, a tela vai tomar `429`
  rapidamente. Trate isso com um debounce/desabilitar o botão durante a chamada, não só
  mostrando o erro depois do fato.

## 5. Fluxos principais, passo a passo

### Dashboard (tela inicial mais provável)

`GET /dashboard` — resumo agregado (contagens por compliance/alerta/filial). Uma
chamada só, sem paginação. Ver `docs/api/dashboard.md` para o shape exato de cada
contagem.

### Lista de dispositivos com filtro

`GET /devices` aceita todos os filtros como query string, combináveis:
`filial`, `departamento`, `complianceState`, `politicaId`, `colaboradorId`, `busca`
(texto livre), `semCheckinDias` (ex.: `semCheckinDias=3` retorna só devices sem
check-in há 3+ dias). Todos opcionais — sem filtro nenhum, lista a frota inteira
paginada.

### Detalhe de um dispositivo (tela com abas)

`GET /devices/:id` — dados principais. As "abas" da tela provavelmente mapeiam direto
pras 3 sub-rotas:

- `GET /devices/:id/apps` — inventário de apps instalados
- `GET /devices/:id/comandos` — histórico de comandos emitidos contra esse device
- `GET /devices/:id/auditoria` — trilha de auditoria específica desse device

`PATCH /devices/:id` — editar o vínculo administrativo (colaborador, linha, patrimônio,
ativo/inativo). Não altera nada na AMAPI, só o cadastro interno.

### Emitir comando contra um device

`POST /devices/:id/comandos`, body varia por `tipo` (union discriminada — o
`openapi.json` já expõe isso como `oneOf`):

```json
{ "tipo": "LOCK" }
{ "tipo": "REBOOT" }
{ "tipo": "RESET_PASSWORD", "novaSenha": "opcional" }
{ "tipo": "CLEAR_APP_DATA", "pacotes": ["com.exemplo.app"] }
{ "tipo": "RELINQUISH_OWNERSHIP" }
{ "tipo": "WIPE", "patrimonioConfirmacao": "<patrimônio digitado pelo usuário>", "motivo": "motivo com 20+ caracteres" }
```

**`WIPE` e `RELINQUISH_OWNERSHIP` são `ADMIN`-only e irreversíveis** — a tela precisa de
uma confirmação explícita de verdade antes de chamar essa rota, não só um
`window.confirm()`. Para `WIPE`, o backend já exige que o usuário **digite de novo** o
número de patrimônio do aparelho (campo `patrimonioConfirmacao`) + um motivo com pelo
menos 20 caracteres — a tela precisa coletar os dois, a API rejeita com `400` se
faltar.

### CRUD de políticas (atenção à latência)

`POST`/`PATCH /policies` **espera a escrita terminar na AMAPI antes de responder** (por
trás, a rota enfileira e aguarda — ver `docs/ARQUITETURA.md`, "Fila de escrita de
política"). Isso significa que essa chamada especificamente pode demorar mais que o
resto da API (a AMAPI real tem latência de rede própria) — mostre um loading state,
não assuma resposta instantânea como nas outras rotas. Timeout do backend é 30s; se
estourar, a tela deve tratar como falha e sugerir tentar de novo (a operação pode ter
sido aplicada ou não — reconsultar `GET /policies/:id` antes de reemitir é mais seguro
que simplesmente reenviar o mesmo `POST`).

### Alertas — ciclo de vida

`GET /alertas` lista (filtráveis por tipo/severidade/status — ver `docs/api/alertas.md`
pros 9 tipos exatos). Duas ações manuais:

- `POST /alertas/:id/reconhecer` — "estou ciente, ainda não resolvi"
- `POST /alertas/:id/resolver` — marca como resolvido manualmente

Note que a maioria dos alertas também **se resolve sozinha** quando a condição deixa de
existir (ex.: device fora de conformidade volta a ficar conforme) — a tela não precisa
sempre mostrar um botão de resolver manual como única forma de um alerta sumir da
lista de "abertos".

### Colaboradores e linhas (cadastro organizacional)

CRUD simples e direto — `GET`/`POST`/`PATCH /colaboradores`, `GET`/`POST`/`PATCH /linhas`.
Sem particularidade além de `TECNICO+` ser o mínimo pra escrever (`VIEWER` só lê,
`AUDITOR` não acessa nenhum dos dois).

## 6. O que ainda NÃO existe na API (não assuma que existe)

- **Não há rota para criar token de enrollment** (o processo de "adicionar um
  aparelho novo" via QR code). Hoje isso só existe como função interna
  (`src/integrations/amapi/enrollment.ts`), sem rota HTTP exposta — é um gap conhecido
  da spec original (`docs/SETUP.md` já registra isso). **Se a tela precisar de um fluxo
  de "adicionar dispositivo", confirme com o time de backend antes de desenhar — a rota
  não existe ainda.**
- **Não há rota de exportação/relatório em CSV/Excel** — só os endpoints JSON
  paginados acima.
- **Não há websocket/notificação em tempo real** — alertas e mudanças de status só
  aparecem quando a tela chama `GET` de novo (poll manual ou refresh periódico fica a
  critério da implementação do frontend).

## 7. Ambiente para desenvolver a tela localmente

Com a API no ar localmente (`docs/SETUP.md`), configure `FRONTEND_URL` no `.env` do
backend apontando pra onde seu dev server roda (ex.: `http://localhost:5173`) — é pra
lá que `/auth/callback` redireciona depois do login. `ALLOWED_ORIGINS` no `.env` do
backend também precisa incluir essa mesma origem, senão o CORS bloqueia suas chamadas
`fetch`.
