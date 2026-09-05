import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type * as QueueModule from '../../src/queues/policy-write-queue.ts';

let redisContainer: StartedRedisContainer;
let enfileirarEscritaPolitica: typeof QueueModule.enfileirarEscritaPolitica;
let criarWorkerEscritaPolitica: typeof QueueModule.criarWorkerEscritaPolitica;
let fecharFilaEscritaPolitica: typeof QueueModule.fecharFilaEscritaPolitica;
let filaEscritaPolitica: typeof QueueModule.filaEscritaPolitica;

beforeAll(async () => {
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  ({
    enfileirarEscritaPolitica,
    criarWorkerEscritaPolitica,
    fecharFilaEscritaPolitica,
    filaEscritaPolitica,
  } = await import('../../src/queues/policy-write-queue.ts'));
}, 60_000);

afterAll(async () => {
  await fecharFilaEscritaPolitica();
  await redisContainer?.stop();
});

describe('fila de escrita de política — concorrência 1 (seção 7)', () => {
  it('nunca processa dois jobs em paralelo, mesmo enfileirando vários de uma vez', async () => {
    let emAndamento = 0;
    let picoDeConcorrencia = 0;
    const ordemDeProcessamento: string[] = [];

    const worker = criarWorkerEscritaPolitica(async (dados) => {
      emAndamento += 1;
      picoDeConcorrencia = Math.max(picoDeConcorrencia, emAndamento);
      // Atraso artificial: se a concorrência fosse > 1, dois jobs
      // sobreporiam esse `await` e o pico seria pego pela asserção abaixo.
      await new Promise((resolve) => setTimeout(resolve, 50));
      ordemDeProcessamento.push(dados.nomePolitica);
      emAndamento -= 1;
    });

    try {
      await Promise.all([
        enfileirarEscritaPolitica({ nomePolitica: 'pol-A', payload: {} }),
        enfileirarEscritaPolitica({ nomePolitica: 'pol-B', payload: {} }),
        enfileirarEscritaPolitica({ nomePolitica: 'pol-C', payload: {} }),
      ]);

      await esperarAte(() => ordemDeProcessamento.length === 3, 10_000);

      expect(picoDeConcorrencia).toBe(1);
      expect(ordemDeProcessamento).toEqual(['pol-A', 'pol-B', 'pol-C']);
    } finally {
      await worker.close();
    }
  });

  it('job com payload real de política chega intacto no processador', async () => {
    const payloadRecebido: unknown[] = [];
    const worker = criarWorkerEscritaPolitica((dados) => {
      payloadRecebido.push(dados.payload);
      return Promise.resolve();
    });

    try {
      await enfileirarEscritaPolitica({
        nomePolitica: 'enterprises/x/policies/administrativo',
        payload: { uninstallAppsDisabled: true, applications: [{ packageName: 'com.a' }] },
      });
      await esperarAte(() => payloadRecebido.length === 1, 10_000);
      expect(payloadRecebido[0]).toEqual({
        uninstallAppsDisabled: true,
        applications: [{ packageName: 'com.a' }],
      });
    } finally {
      await worker.close();
    }
  });

  it('a fila em si expõe o nome esperado, útil pra dashboards/monitoramento futuros', () => {
    expect(filaEscritaPolitica.name).toBe('escrita-politica');
  });
});

// Helper local de polling — mais direto que configurar fake timers junto
// com um Worker de verdade conversando com Redis via rede (mesmo que
// local/container), que roda em tempo real de qualquer forma.
async function esperarAte(condicao: () => boolean, timeoutMs: number): Promise<void> {
  const inicio = Date.now();
  while (!condicao()) {
    if (Date.now() - inicio > timeoutMs) {
      throw new Error('timeout esperando a condição ficar verdadeira');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
