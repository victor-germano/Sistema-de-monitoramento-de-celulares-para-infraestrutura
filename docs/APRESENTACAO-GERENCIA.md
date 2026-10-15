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

| Capacidade                                                | O que significa na prática                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Controle remoto dos aparelhos**                         | Bloquear, reiniciar, apagar remotamente (perda/roubo), redefinir senha — tudo rastreado e com aprovação extra para ações irreversíveis                                                                       |
| **Nenhum app obrigatório pode ser removido pelo usuário** | Garantido por regra de sistema, não por combinado verbal com o colaborador                                                                                                                                   |
| **Vínculo organizacional completo**                       | Cada aparelho sabe de quem é, de qual filial, qual linha telefônica usa, qual o patrimônio                                                                                                                   |
| **Alertas automáticos de conformidade**                   | O sistema avisa sozinho quando um aparelho está desatualizado, com pouco espaço, bateria crítica, fora da política de segurança, sem reportar há dias, ou uma linha telefônica sem aparelho nenhum vinculado |
| **Painel de visão geral (dashboard)**                     | Resumo de quantos aparelhos estão em conformidade, quantos alertas abertos, por filial/tipo                                                                                                                  |
| **Login corporativo**                                     | Ninguém usa senha própria do sistema — acesso é pelo mesmo login já usado na empresa, com 4 níveis de permissão (de "só consulta" a "administrador completo")                                                |
| **Trilha de auditoria**                                   | Todo acesso e toda ação administrativa fica registrado de forma que nem um administrador do sistema consegue apagar depois                                                                                   |

Esse conjunto já passou por **281 testes automatizados**, incluindo testes contra
banco de dados e fila de mensagens reais (não só simulados) — não é uma versão
"de demonstração", é código testado com o mesmo rigor que se espera de um sistema
que vai controlar aparelhos de verdade.

## O que está sendo entregue agora

Esta etapa (chamada internamente de "Fase 7") produz a documentação necessária para
**outro time construir a tela** (o que o usuário final realmente vai ver e usar no
dia a dia) e para o time de infraestrutura operar o sistema no dia a dia. Até aqui,
só existia o "motor" por trás — funcional, testado, mas sem interface visual.

## O que falta para ir ao ar de verdade

Duas coisas bem diferentes:

**1. Construir a tela (interface visual).** Hoje o sistema só responde a comandos
técnicos (API) — não tem nenhuma tela para um humano clicar. Essa é a próxima etapa
natural, e esta documentação que está sendo produzida agora é exatamente o que o time
que for construir a tela vai usar como ponto de partida.

**2. Três informações que só a empresa pode fornecer** — nenhuma equipe técnica
consegue adivinhar ou decidir isso sozinha:

| O que falta                                                                                                | Por que é necessário                                                                                              | Quem decide                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Confirmação do cadastro da empresa junto ao Google (conta "enterprise" da Android Management API)          | Sem isso, o sistema não consegue conversar de verdade com os aparelhos — hoje só foi testado em ambiente simulado | Grupo Roveri, junto ao fornecedor/TI que administra a conta Google da empresa |
| Nome do canal de notificação (Pub/Sub) que o Google usa para avisar o sistema sobre mudanças nos aparelhos | Sem isso, o sistema não recebe avisos automáticos dos aparelhos (bateria, localização, conformidade)              | Mesma equipe acima                                                            |
| Lista oficial de filiais da empresa                                                                        | Para que os relatórios por filial fiquem completos e corretos desde o primeiro dia                                | Grupo Roveri (RH/administrativo)                                              |

Nenhuma dessas três pendências é um problema técnico ou atraso da equipe de
desenvolvimento — são decisões/informações que dependem de alguém da empresa.

## Resumo executivo

- **Pronto e testado:** o sistema que controla os aparelhos (o "motor").
- **Em andamento agora:** a documentação para construir a tela e para operar em
  produção.
- **Pendente (depende da empresa, não da equipe técnica):** três confirmações/dados
  listados acima, necessários antes do primeiro teste real contra um aparelho físico.
- **Ainda não iniciado:** a construção da tela em si (próxima etapa, depois desta
  documentação).
