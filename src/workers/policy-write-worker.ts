// Worker dedicado (`npm run worker:policy-write`) — processa a fila
// serializada de escrita de política (`src/queues/policy-write-queue.ts`,
// Fase 3) chamando `salvarPolitica` de verdade. Processo separado da API,
// mesmo padrão do `worker:pubsub` (Fase 4): a API só ENFILEIRA
// (`executarEscritaPoliticaSincrona`), nunca chama `salvarPolitica`
// diretamente — é isso que garante concorrência 1 de verdade, mesmo com
// vários processos de API rodando atrás de um load balancer.
import type { Worker } from 'bullmq';
import {
  criarWorkerEscritaPolitica,
  fecharFilaEscritaPolitica,
} from '../queues/policy-write-queue.ts';
import { salvarPolitica, type PolicyPayload } from '../integrations/amapi/policies.ts';
import { logger } from '../shared/logger.ts';
import { ehExecutadoDiretamente } from '../shared/entrypoint.ts';

export function iniciarWorkerEscritaPolitica(): Worker {
  const worker = criarWorkerEscritaPolitica(async (dados): Promise<PolicyPayload> =>
    salvarPolitica(dados.nomePolitica, dados.payload),
  );
  logger.info('worker de escrita de política iniciado');
  return worker;
}

// Entrypoint do processo dedicado — só roda quando o arquivo é executado
// diretamente, não quando importado por teste.
if (ehExecutadoDiretamente(import.meta.url, process.argv[1])) {
  const worker = iniciarWorkerEscritaPolitica();

  const desligar = async (): Promise<void> => {
    logger.info('worker de escrita de política: encerrando...');
    await worker.close();
    await fecharFilaEscritaPolitica();
    process.exit(0);
  };

  process.on('SIGTERM', () => void desligar());
  process.on('SIGINT', () => void desligar());
}
