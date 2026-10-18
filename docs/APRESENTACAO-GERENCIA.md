# Sistema de Monitoramento de Celulares — resumo para gerência

## O problema que isso resolve

O Grupo Roveri hoje gerencia os smartphones corporativos (100% da empresa, não
aparelho pessoal) através de um serviço de terceiros, o **Miradore**. Esse serviço
funciona, mas não conhece a estrutura da empresa: não sabe qual colaborador usa qual
aparelho, de qual filial, de qual centro de custo, nem integra com a linha telefônica
corporativa vinculada. Toda essa informação hoje vive solta, fora do sistema de
gestão dos aparelhos.

Este projeto substitui o Miradore por um sistema próprio, construído sobre a mesma
tecnologia que o Google oferece para gestão de frotas Android (a mesma base técnica
que soluções como o Miradore usam por trás), mas com a organização da empresa
embutida desde o primeiro dia.

## O que já está pronto

| Capacidade                                                | O que significa na prática                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Painel visual completo**                                | Tela de verdade, testada manualmente em cada fluxo — dashboard, dispositivos, políticas, alertas, colaboradores, linhas e usuários, não só uma API respondendo comando técnico                          |
| **Controle remoto dos aparelhos**                         | Bloquear, reiniciar, apagar remotamente (perda/roubo), redefinir senha — tudo rastreado e com aprovação extra para ações irreversíveis (é preciso digitar uma palavra de confirmação, não só um clique) |
| **Cadastro de novo aparelho pelo próprio painel**         | O técnico gera o código de ativação (QR) direto na tela, sem precisar de nenhum comando técnico                                                                                                         |
| **Nenhum app obrigatório pode ser removido pelo usuário** | Garantido por regra de sistema, não por combinado verbal com o colaborador                                                                                                                              |
| **Vínculo organizacional completo, editável pelo painel** | Cada aparelho sabe de quem é, de qual filial, qual linha telefônica usa, qual o patrimônio — e dá pra corrigir esse vínculo direto na tela quando necessário                                            |
| **Alertas automáticos de conformidade**                   | O sistema avisa sozinho quando um aparelho está desatualizado, com pouco espaço, bateria crítica, fora da política de segurança, sem reportar há dias, ou uma linha telefônica sem aparelho vinculado   |
| **Painel de visão geral (dashboard)**                     | Resumo de quantos aparelhos estão em conformidade, quantos alertas abertos, por filial/tipo — clicável, leva direto pra lista filtrada                                                                  |
| **Login corporativo**                                     | Ninguém usa senha própria do sistema — acesso é pelo mesmo login já usado na empresa, com 4 níveis de permissão (de "só consulta" a "administrador completo"), incluindo desativar acesso de quem sai   |
| **Trilha de auditoria**                                   | Todo acesso e toda ação administrativa fica registrado de forma que nem um administrador do sistema consegue apagar depois                                                                              |

Esse conjunto já passou por **344 testes automatizados** no backend (contra banco de
dados e fila de mensagens reais, não só simulados) mais validação manual de cada tela
do painel, uma a uma, incluindo os casos de erro (página inexistente, confirmação com
a palavra errada, etc.). Não é uma versão "de demonstração" — é código testado com o
mesmo rigor que se espera de um sistema que vai controlar aparelhos de verdade, e uma
revisão de performance recente já corrigiu os pontos que apareceriam conforme o uso
crescesse (consultas lentas, buscas feitas em sequência quando podiam ser paralelas).

## O que falta para ir ao ar de verdade

Duas coisas bem diferentes — nenhuma delas é "falta construir algo":

**1. Login real e o primeiro deploy.** O sistema roda e foi validado localmente, mas
ninguém além de quem está desenvolvendo consegue acessar ainda: falta configurar o
login corporativo de verdade (hoje ainda aponta pra credenciais de exemplo) e subir o
sistema pro ambiente onde a empresa vai operá-lo. **Essa etapa é da equipe de
infraestrutura da empresa**, que já tem o login corporativo (OIDC) configurado e vai
cuidar do deploy — não depende de mais nenhum código novo, só de configuração do lado
deles. O projeto já documenta exatamente o que essa equipe precisa preencher
(`docs/SETUP.md`, `docs/OPERACAO.md`, `render.yaml`).

**2. Três informações que só a empresa pode fornecer** — nenhuma equipe técnica
consegue adivinhar ou decidir isso sozinha:

| O que falta                                                                                                | Por que é necessário                                                                                              | Quem decide                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Confirmação do cadastro da empresa junto ao Google (conta "enterprise" da Android Management API)          | Sem isso, o sistema não consegue conversar de verdade com os aparelhos — hoje só foi testado em ambiente simulado | Grupo Roveri, junto ao fornecedor/TI que administra a conta Google da empresa |
| Nome do canal de notificação (Pub/Sub) que o Google usa para avisar o sistema sobre mudanças nos aparelhos | Sem isso, o sistema não recebe avisos automáticos dos aparelhos (bateria, localização, conformidade)              | Mesma equipe acima                                                            |
| Lista oficial de filiais da empresa                                                                        | Para que os relatórios por filial fiquem completos e corretos desde o primeiro dia                                | Grupo Roveri (RH/administrativo)                                              |

Nenhuma dessas pendências é um problema técnico ou atraso da equipe de
desenvolvimento — são decisões/informações/configurações que dependem de alguém da
empresa, não de mais código.

## Resumo executivo

- **Pronto e testado:** o sistema completo — "motor" (API, 3 processos em segundo
  plano) e painel visual, os dois testados.
- **Pendente (depende da empresa/infra, não de mais desenvolvimento):** login
  corporativo real + primeiro deploy (equipe de infraestrutura), e as três
  confirmações/dados listados acima (RH/TI administrativo).
- **Não há mais "próxima etapa de construção"** — o que falta agora é colocar no ar,
  não construir.
