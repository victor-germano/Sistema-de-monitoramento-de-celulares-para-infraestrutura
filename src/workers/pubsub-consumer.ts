// Worker dedicado (`npm run worker:pubsub`) — consome a subscription pull da
// AMAPI (seção 8) e traduz cada mensagem em efeito no banco. Processo
// separado do servidor HTTP (`src/server.ts`), assim como o worker de
// escrita de política roda fora do processo da API.
//
// ADR-017 (docs/DECISOES.md) documenta o formato real da mensagem, já
// confirmado contra a documentação oficial do Google — este arquivo segue
// essa decisão à risca:
//   - `notificationType` vem de `message.attributes`, não de dentro de `data`;
//   - `data` é o RECURSO cru (Device pra ENROLLMENT/STATUS_REPORT), não um
//     envelope com um campo a mais;
//   - a notificação de teste vem como `test`/`TEST` (case-insensitive);
//   - `eventos_brutos.payload` grava `{ attributes, data }` juntos — a
//     mensagem inteira, não só o recurso — pra não perder informação
//     nenhuma quando `POST /internal/pubsub/replay` reprocessar.
//
// O processamento em si (dispatch por `notificationType`, transação,
// marcação de `processado_em`/`erro`) vive em
// `src/domain/eventos/processar-evento.ts`, compartilhado com o replay
// manual — este arquivo só cuida do que é específico de mensagem Pub/Sub
// de verdade: ack/nack e o watchdog de saúde da subscription.
import { PubSub, type Message } from '@google-cloud/pubsub';
import { env } from '../config/env.ts';
import { db } from '../db/client.ts';
import { eventosBrutos } from '../db/schema/eventos-brutos.ts';
import { logger } from '../shared/logger.ts';
import { criarWatchdog } from './watchdog.ts';
import { processarEventoBruto } from '../domain/eventos/processar-evento.ts';

// Minutos sem NENHUMA mensagem processada até soar o alerta de saúde do
// pipeline. A AMAPI manda `STATUS_REPORT` periodicamente pra toda a frota
// (seção 8) — silêncio total por muito tempo é sinal de subscription
// travada/credencial expirada, não "frota parada". Sem env var própria: é
// um limite operacional interno do worker, não uma decisão de negócio.
const WATCHDOG_LIMITE_MINUTOS = 15;

function ehNotificacaoDeTeste(notificationType: string): boolean {
  return notificationType.toLowerCase() === 'test';
}

/**
 * Grava o evento cru (idempotente por `messageId`) e delega o processamento
 * de domínio a `processarEventoBruto`; só faz `ack()` depois do commit — se
 * cair a conexão/processo no meio, a mensagem NÃO foi confirmada e o
 * Pub/Sub reentrega (at-least-once, seção 8).
 */
async function processarMensagem(message: Message): Promise<void> {
  const notificationType = message.attributes.notificationType ?? '';

  if (ehNotificacaoDeTeste(notificationType)) {
    logger.info(
      { messageId: message.id },
      'Pub/Sub: notificação de teste recebida, ack sem processar',
    );
    message.ack();
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(message.data.toString('utf8'));
  } catch (erro) {
    // Payload malformado é irrecuperável por retry — reenviar não conserta
    // um JSON quebrado. Ack pra não travar a subscription num loop infinito
    // de redelivery; o problema fica só visível no log.
    logger.error(
      { err: erro, messageId: message.id },
      'Pub/Sub: payload não é JSON válido — descartando',
    );
    message.ack();
    return;
  }

  const [eventoBruto] = await db
    .insert(eventosBrutos)
    .values({
      messageId: message.id,
      notificationType,
      payload: { attributes: message.attributes, data },
    })
    .onConflictDoNothing({ target: eventosBrutos.messageId })
    .returning();

  if (!eventoBruto) {
    // Redelivery de uma mensagem já registrada (at-least-once é a regra, não
    // exceção). Se já processou, não reprocessa; se falhou antes, fica
    // pendente pra `POST /internal/pubsub/replay` decidir — o consumer não
    // re-tenta sozinho em loop silencioso.
    logger.info(
      { messageId: message.id },
      'Pub/Sub: mensagem já registrada (redelivery), ack sem reprocessar',
    );
    message.ack();
    return;
  }

  const resultado = await processarEventoBruto(eventoBruto.id);
  if (resultado.status === 'erro') {
    logger.error(
      { messageId: message.id, notificationType, erro: resultado.mensagem },
      'Pub/Sub: falha ao processar mensagem',
    );
    message.nack();
    return;
  }
  // `sem_handler` também é `ack()`: o evento cru já está salvo pra replay
  // futuro quando o handler existir — não é um erro transitório que reenviar
  // resolveria.
  message.ack();
}

export interface ConsumerPubSub {
  parar(): Promise<void>;
}

export function iniciarConsumerPubSub(): ConsumerPubSub {
  const pubsub = new PubSub({ projectId: env.GOOGLE_CLOUD_PROJECT });
  const subscription = pubsub.subscription(env.PUBSUB_SUBSCRIPTION);

  const watchdog = criarWatchdog(WATCHDOG_LIMITE_MINUTOS, (minutosParado) => {
    logger.warn(
      { minutosSemProcessar: Math.round(minutosParado) },
      'Pub/Sub: nenhuma mensagem processada há muito tempo — verificar subscription/credencial',
    );
  });

  const aoReceberMensagem = (message: Message): void => {
    processarMensagem(message)
      .catch((erro: unknown) => {
        // Só chega aqui um erro FORA do try/catch de `processarMensagem`
        // (ex.: falha no próprio insert de `eventos_brutos`) — a mensagem
        // não foi nem ack nem nack ainda; nack pra garantir redelivery em
        // vez de deixá-la presa esperando o ack timeout do Pub/Sub.
        logger.error(
          { err: erro, messageId: message.id },
          'Pub/Sub: erro não tratado processando mensagem',
        );
        message.nack();
      })
      .finally(() => watchdog.registrarAtividade());
  };

  subscription.on('message', aoReceberMensagem);
  subscription.on('error', (erro: unknown) => {
    logger.error({ err: erro }, 'Pub/Sub: erro na subscription');
  });

  logger.info({ subscription: env.PUBSUB_SUBSCRIPTION }, 'Pub/Sub: consumer iniciado');

  return {
    async parar() {
      watchdog.parar();
      subscription.removeListener('message', aoReceberMensagem);
      await subscription.close();
    },
  };
}

// Entrypoint do processo dedicado (`npm run worker:pubsub`) — só roda
// quando o arquivo é executado diretamente, não quando importado por teste.
if (import.meta.url === `file://${process.argv[1]}`) {
  const consumer = iniciarConsumerPubSub();

  const desligar = async (): Promise<void> => {
    logger.info('Pub/Sub: encerrando consumer...');
    await consumer.parar();
    process.exit(0);
  };

  process.on('SIGTERM', () => void desligar());
  process.on('SIGINT', () => void desligar());
}
