# LGPD — Inventário de dados pessoais e retenção

> **Aviso:** este documento descreve **fatos verificáveis no código** — que dado existe,
> onde fica, por quanto tempo. Não é parecer jurídico. A base legal de cada tratamento e
> os pontos marcados como "pendência jurídica" abaixo precisam de revisão do time de
> compliance/jurídico do Grupo Roveri antes de considerar o sistema conforme.

## Quem são os titulares de dados aqui

Dois grupos distintos, tratados de forma diferente pelo sistema:

1. **Colaboradores da empresa** (donos dos dispositivos corporativos) — dado funcional,
   não de login. Nunca acessam o sistema diretamente.
2. **Usuários do painel** (time de infraestrutura/helpdesk que opera o sistema) — fazem
   login via OIDC corporativo.

Frota monitorada é **100% corporativa** (não-BYOD) — não há dado pessoal de dispositivo
de terceiros fora do escopo trabalhista.

## Inventário de dados pessoais por tabela

| Tabela                            | Campos com dado pessoal                                                | Titular                                           | Observação                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `colaboradores`                   | `nome`, `email`, `matricula`, `filial`, `departamento`, `centro_custo` | Colaborador                                       | Dado funcional/trabalhista — identifica quem usa cada device                                                                                                                                                                                                                                                 |
| `usuarios`                        | `email`, `nome`, `oidc_subject`, `ultimo_login`                        | Usuário do painel                                 | `oidc_subject` é o identificador estável do provedor OIDC, não muda se o e-mail mudar                                                                                                                                                                                                                        |
| `dispositivos`                    | `imei`, `serial`, `colaborador_id` (vínculo)                           | Colaborador (via vínculo)                         | Identificadores de hardware, não diretamente de pessoa, mas re-identificáveis via o vínculo com `colaboradores`                                                                                                                                                                                              |
| `dispositivos.ultima_localizacao` | Coordenadas (jsonb)                                                    | Colaborador                                       | **Coluna existe no schema mas nunca é preenchida hoje** — a AMAPI não reporta localização de forma contínua (só via recurso "Lost Mode", fora de escopo por decisão confirmada, ADR-026). Guardada atrás de feature-flag (`COLETA_LOCALIZACAO_ATIVA`) que hoje está sempre efetivamente desligada na prática |
| `linhas`                          | `numero` (telefone)                                                    | Colaborador (indiretamente, via device vinculado) | Linha é um ativo corporativo, mas o número em si pode ser considerado dado pessoal quando vinculado a um usuário específico                                                                                                                                                                                  |
| `auditoria`                       | `ator_email`, `ip`, `user_agent`                                       | Usuário do painel                                 | Trilha de quem fez o quê — `ator_email` é cópia (não FK), sobrevive à remoção do usuário de propósito (ver `docs/ARQUITETURA.md`)                                                                                                                                                                            |
| `comandos`                        | `emitido_por` (referência a usuário)                                   | Usuário do painel                                 | Histórico de comandos emitidos contra um device                                                                                                                                                                                                                                                              |
| `eventos_brutos`                  | Payload cru da AMAPI (pode conter IMEI/serial do `Device`)             | Colaborador (indiretamente)                       | Mensagem Pub/Sub inteira, antes de qualquer processamento                                                                                                                                                                                                                                                    |

## Dado que o sistema explicitamente NÃO coleta (decisão de produto, não limitação)

- **Localização contínua** — mesmo com a coluna existindo no schema, a AMAPI não
  oferece essa coleta de forma contínua; o recurso que oferece ("Lost Mode") não foi
  implementado, por decisão confirmada com o Victor (ADR-026). Se isso mudar no futuro,
  é uma decisão de produto que deve passar por análise de base legal específica antes
  de ativar.
- **Senha de device (`RESET_PASSWORD`)** — o valor da nova senha nunca é persistido no
  histórico de comandos (`comandos.payload` usa allowlist, não cópia do body da
  requisição — ADR-024). O comando é executado, mas o segredo em si não fica guardado
  em lugar nenhum do banco.
- **Conteúdo de apps/arquivos do device** — só inventário de apps instalados
  (`dispositivo_apps`: nome do pacote, versão, estado de instalação), nunca dado de uso
  ou conteúdo.

## Retenção

| Dado                                                  | Retenção                                                                                    | Mecanismo                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventos_brutos`                                      | `RETENCAO_EVENTOS_BRUTOS_DIAS` (padrão 180 dias)                                            | Purga automática, `src/domain/lgpd/retencao.ts`, rodada pelo `worker:manutencao`. Só apaga eventos **já processados com sucesso** — um evento com erro fica retido até alguém investigar e reprocessar via `POST /internal/pubsub/replay`, mesmo que já tenha passado da idade limite (de propósito: apagar pela idade destruiria a única cópia do payload original antes da correção) |
| `colaboradores`, `dispositivos`, `linhas`, `comandos` | **Sem purga automática**                                                                    | Vive enquanto o registro existir no banco — hoje não há rotina de anonimização/exclusão ao desligamento de um colaborador ou baixa de um device                                                                                                                                                                                                                                        |
| `auditoria`                                           | **Sem purga — append-only por design**                                                      | Trigger de banco impede `UPDATE`/`DELETE` até para `ADMIN` (ADR-008). Retenção indefinida é intencional (trilha de auditoria), mas deve ser confrontada com política de retenção da empresa                                                                                                                                                                                            |
| `usuarios`, `refresh_tokens`                          | Sessão expira (`REFRESH_TOKEN_TTL_HOURS`), mas o registro de `usuarios` em si não é purgado | —                                                                                                                                                                                                                                                                                                                                                                                      |

## Direitos do titular — o que já existe, o que falta

O sistema tem CRUD de `colaboradores` (`GET`/`POST`/`PATCH /colaboradores`), que cobre
parcialmente direito de acesso e correção — mas:

- **Não existe** uma rota de exportação consolidada ("todos os dados que o sistema tem
  sobre o colaborador X", juntando `colaboradores` + `dispositivos` vinculados +
  `comandos` + menções em `auditoria`).
- **Não existe** rotina de anonimização/exclusão ao desligamento — hoje o caminho seria
  `colaboradores.ativo = false` (soft) ou um `DELETE` manual direto no banco, sem efeito
  cascata documentado sobre `dispositivos.colaborador_id` (fica `NULL` por causa do
  `ON DELETE` da FK, mas verificar o comportamento real antes de usar isso como
  processo de exclusão de titular).
- Auditoria (`auditoria`) **nunca é afetada** por nenhuma dessas ações — por design,
  mesmo que o colaborador peça exclusão de seus dados, o registro de "quem fez o quê"
  permanece (`ator_email` é cópia, sobrevive à remoção do ator original).

## Segurança aplicada aos dados pessoais

- Logs (Pino) têm **redaction pré-configurada** — segredos e, na configuração atual,
  campos sensíveis não vazam em texto plano no log (ver `src/shared/logger.ts`).
- Sessão via JWT de vida curta (15 min) + refresh token opaco em cookie `httpOnly`
  (nunca acessível via JavaScript do browser).
- RBAC em 100% das rotas (`docs/ARQUITETURA.md`) — acesso a dado de colaborador/device
  é restrito por papel, `AUDITOR` não acessa `/devices/*` nem `/colaboradores/*`.
- `novaSenha` de `RESET_PASSWORD` nunca persistida (ADR-024, já citado acima).

## Pendências para revisão jurídica (não decidíveis só pelo código)

1. **Base legal de cada tratamento** — provavelmente execução de contrato de
   trabalho/legítimo interesse de segurança patrimonial para a maior parte dos campos,
   mas isso precisa de confirmação formal do jurídico, não de suposição técnica.
2. **Política de retenção para `colaboradores`/`dispositivos`/`comandos`** — hoje não
   há prazo definido; o jurídico precisa decidir um prazo (ex.: X anos após
   desligamento/baixa do ativo) para alguém então implementar a purga correspondente.
3. **Processo formal de atendimento a direito do titular** (exportação, correção,
   eliminação) — a infraestrutura técnica (CRUD de colaboradores) existe parcialmente,
   mas falta a camada de processo e as rotas que faltam, listadas acima.
4. **Ativação futura de `COLETA_LOCALIZACAO_ATIVA`/"Lost Mode"** — se o negócio decidir
   ativar coleta de localização no futuro, isso precisa de nova análise de base legal e
   de informação ao titular antes de qualquer linha de código mudar, não depois.
