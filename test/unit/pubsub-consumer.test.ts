import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fronteira de rede (Pub/Sub) e o núcleo de processamento
// (`processarEventoBruto`, já coberto por
// `test/integration/fase4-inventario.test.ts` contra um Postgres real) são
// mockados aqui — o que este arquivo testa é só a orquestração:
// idempotência do insert cru, ack/nack conforme o resultado, e o ciclo de
// vida do consumer (start/stop).
const {
  subscriptionFakeRef,
  pubsubSubscriptionMock,
  insertChain,
  dbInsertMock,
  selectChain,
  dbSelectMock,
  processarEventoBrutoMock,
} = vi.hoisted(() => {
  const subscriptionFakeRef: { atual?: EventEmitter & { close: ReturnType<typeof vi.fn> } } = {};
  const pubsubSubscriptionMock = vi.fn().mockImplementation(() => {
    subscriptionFakeRef.atual = Object.assign(new EventEmitter(), {
      close: vi.fn().mockResolvedValue(undefined),
    });
    return subscriptionFakeRef.atual;
  });
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  const dbInsertMock = vi.fn().mockReturnValue(insertChain);
  // Usado só no caminho de redelivery (achado numa revisão): precisa saber
  // se a linha já existente foi processada com sucesso antes de decidir
  // ack sem reprocessar vs. tentar de novo.
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
  const dbSelectMock = vi.fn().mockReturnValue(selectChain);
  const processarEventoBrutoMock = vi.fn();
  return {
    subscriptionFakeRef,
    pubsubSubscriptionMock,
    insertChain,
    dbInsertMock,
    selectChain,
    dbSelectMock,
    processarEventoBrutoMock,
  };
});

vi.mock('@google-cloud/pubsub', () => ({
  PubSub: vi.fn().mockImplementation(() => ({ subscription: pubsubSubscriptionMock })),
}));
vi.mock('../../src/db/client.ts', () => ({ db: { insert: dbInsertMock, select: dbSelectMock } }));
vi.mock('../../src/domain/eventos/processar-evento.ts', () => ({
  processarEventoBruto: processarEventoBrutoMock,
}));

const { iniciarConsumerPubSub } = await import('../../src/workers/pubsub-consumer.ts');

function criarMensagem(overrides: {
  notificationType?: string;
  dataObjeto?: unknown;
  dataBruta?: string;
}): {
  id: string;
  attributes: Record<string, string>;
  data: Buffer;
  ack: () => void;
  nack: () => void;
} {
  return {
    id: `msg-${Math.random()}`,
    attributes: overrides.notificationType ? { notificationType: overrides.notificationType } : {},
    data: Buffer.from(overrides.dataBruta ?? JSON.stringify(overrides.dataObjeto ?? {})),
    ack: vi.fn(),
    nack: vi.fn(),
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  insertChain.returning.mockReset();
  selectChain.limit.mockReset();
});

describe('pubsub-consumer', () => {
  it('notificação de teste (test/TEST) faz ack sem tocar o banco', async () => {
    iniciarConsumerPubSub();
    const mensagem = criarMensagem({ notificationType: 'test' });

    subscriptionFakeRef.atual!.emit('message', mensagem);
    await flushPromises();

    expect(mensagem.ack).toHaveBeenCalledOnce();
    expect(mensagem.nack).not.toHaveBeenCalled();
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('payload que não é JSON válido faz ack (irrecuperável por retry)', async () => {
    iniciarConsumerPubSub();
    const mensagem = criarMensagem({ notificationType: 'ENROLLMENT', dataBruta: 'não-é-json{' });

    subscriptionFakeRef.atual!.emit('message', mensagem);
    await flushPromises();

    expect(mensagem.ack).toHaveBeenCalledOnce();
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('mensagem nova + processamento OK -> ack', async () => {
    iniciarConsumerPubSub();
    insertChain.returning.mockResolvedValueOnce([{ id: 1 }]);
    processarEventoBrutoMock.mockResolvedValueOnce({ status: 'processado' });
    const mensagem = criarMensagem({
      notificationType: 'ENROLLMENT',
      dataObjeto: { name: 'dev-1' },
    });

    subscriptionFakeRef.atual!.emit('message', mensagem);
    await flushPromises();

    expect(processarEventoBrutoMock).toHaveBeenCalledWith(1);
    expect(mensagem.ack).toHaveBeenCalledOnce();
    expect(mensagem.nack).not.toHaveBeenCalled();
  });

  it('mensagem nova + sem_handler -> ack (evento fica salvo pra replay futuro)', async () => {
    iniciarConsumerPubSub();
    insertChain.returning.mockResolvedValueOnce([{ id: 2 }]);
    processarEventoBrutoMock.mockResolvedValueOnce({ status: 'sem_handler' });
    const mensagem = criarMensagem({ notificationType: 'ENTERPRISE_UPGRADE', dataObjeto: {} });

    subscriptionFakeRef.atual!.emit('message', mensagem);
    await flushPromises();

    expect(mensagem.ack).toHaveBeenCalledOnce();
  });

  it('mensagem nova + erro no processamento -> nack (Pub/Sub reentrega)', async () => {
    iniciarConsumerPubSub();
    insertChain.returning.mockResolvedValueOnce([{ id: 3 }]);
    processarEventoBrutoMock.mockResolvedValueOnce({ status: 'erro', mensagem: 'falhou' });
    const mensagem = criarMensagem({ notificationType: 'STATUS_REPORT', dataObjeto: {} });

    subscriptionFakeRef.atual!.emit('message', mensagem);
    await flushPromises();

    expect(mensagem.nack).toHaveBeenCalledOnce();
    expect(mensagem.ack).not.toHaveBeenCalled();
  });

  describe('redelivery (messageId já existe — onConflictDoNothing não retorna linha)', () => {
    it('linha existente já processada com sucesso -> ack sem reprocessar', async () => {
      iniciarConsumerPubSub();
      insertChain.returning.mockResolvedValueOnce([]);
      selectChain.limit.mockResolvedValueOnce([{ id: 10, processadoEm: new Date() }]);
      const mensagem = criarMensagem({ notificationType: 'ENROLLMENT', dataObjeto: {} });

      subscriptionFakeRef.atual!.emit('message', mensagem);
      await flushPromises();

      expect(processarEventoBrutoMock).not.toHaveBeenCalled();
      expect(mensagem.ack).toHaveBeenCalledOnce();
    });

    // Achado numa revisão: antes, QUALQUER redelivery acabava em ack
    // incondicional — mesmo uma que tinha falhado por erro transitório
    // (processado_em ainda null) nunca tinha uma segunda chance automática,
    // só via POST /internal/pubsub/replay manual. Os dois testes abaixo
    // provam que agora reprocessa de verdade.
    it('linha existente NUNCA processada (falhou antes) + reprocessamento dá certo -> reprocessa e ack', async () => {
      iniciarConsumerPubSub();
      insertChain.returning.mockResolvedValueOnce([]);
      selectChain.limit.mockResolvedValueOnce([{ id: 11, processadoEm: null }]);
      processarEventoBrutoMock.mockResolvedValueOnce({ status: 'processado' });
      const mensagem = criarMensagem({ notificationType: 'STATUS_REPORT', dataObjeto: {} });

      subscriptionFakeRef.atual!.emit('message', mensagem);
      await flushPromises();

      expect(processarEventoBrutoMock).toHaveBeenCalledWith(11);
      expect(mensagem.ack).toHaveBeenCalledOnce();
      expect(mensagem.nack).not.toHaveBeenCalled();
    });

    it('linha existente NUNCA processada + reprocessamento falha de novo -> nack (continua elegível pra redelivery)', async () => {
      iniciarConsumerPubSub();
      insertChain.returning.mockResolvedValueOnce([]);
      selectChain.limit.mockResolvedValueOnce([{ id: 12, processadoEm: null }]);
      processarEventoBrutoMock.mockResolvedValueOnce({ status: 'erro', mensagem: 'ainda falha' });
      const mensagem = criarMensagem({ notificationType: 'STATUS_REPORT', dataObjeto: {} });

      subscriptionFakeRef.atual!.emit('message', mensagem);
      await flushPromises();

      expect(mensagem.nack).toHaveBeenCalledOnce();
      expect(mensagem.ack).not.toHaveBeenCalled();
    });

    it('corrida rara (linha não encontrada na releitura) -> nack, nunca perde a mensagem', async () => {
      iniciarConsumerPubSub();
      insertChain.returning.mockResolvedValueOnce([]);
      selectChain.limit.mockResolvedValueOnce([]);
      const mensagem = criarMensagem({ notificationType: 'ENROLLMENT', dataObjeto: {} });

      subscriptionFakeRef.atual!.emit('message', mensagem);
      await flushPromises();

      expect(processarEventoBrutoMock).not.toHaveBeenCalled();
      expect(mensagem.nack).toHaveBeenCalledOnce();
    });
  });

  it('erro fora do fluxo tratado (ex.: o próprio insert falha) -> nack, nunca fica sem resposta', async () => {
    iniciarConsumerPubSub();
    insertChain.returning.mockRejectedValueOnce(new Error('conexão caiu'));
    const mensagem = criarMensagem({ notificationType: 'ENROLLMENT', dataObjeto: {} });

    subscriptionFakeRef.atual!.emit('message', mensagem);
    await flushPromises();

    expect(mensagem.nack).toHaveBeenCalledOnce();
  });

  it('parar() fecha a subscription', async () => {
    const consumer = iniciarConsumerPubSub();
    const subscription = subscriptionFakeRef.atual!;

    await consumer.parar();

    expect(subscription.close).toHaveBeenCalledOnce();
  });
});
