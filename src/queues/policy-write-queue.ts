import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.ts';
import { logger } from '../shared/logger.ts';
import type { PolicyPayload } from '../integrations/amapi/policies.ts';

export const NOME_FILA_ESCRITA_POLITICA = 'escrita-politica';

export interface EscritaPoliticaJobData {
  nomePolitica: string;
  payload: PolicyPayload;
}

// Conexões DEDICADAS pra esta fila — não reaproveita `shared/redis-client.ts`
// (usado só pro health check) nem compartilha uma única conexão entre Queue
// e Worker. O Worker do BullMQ passa boa parte do tempo bloqueado num
// `BRPOPLPUSH`-like esperando job novo; se dividisse conexão com o
// producer (`Queue.add`), toda chamada do producer ficaria enfileirada
// atrás desse bloqueio na mesma conexão TCP. `maxRetriesPerRequest: null`
// é exigência do próprio BullMQ (documentado), não opcional.
const conexaoProducer = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const conexaoWorker = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
// Terceira conexão dedicada — `QueueEvents` escuta os eventos de conclusão/
// falha de job via pub/sub do Redis, mesmo padrão de isolamento das outras
// duas (nunca compartilhar conexão entre papéis diferentes de BullMQ).
const conexaoEventos = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Rate limit da AMAPI é por projeto, não por dispositivo (seção 7) —
 * `policies.patch` de dois admins ao mesmo tempo é uma corrida de verdade,
 * não só um jeito de estourar quota. `concurrency: 1` no worker (abaixo) é
 * o que serializa toda escrita de política, uma de cada vez, na ordem em
 * que chegaram na fila.
 */
export const filaEscritaPolitica = new Queue<EscritaPoliticaJobData>(NOME_FILA_ESCRITA_POLITICA, {
  connection: conexaoProducer,
});

export function enfileirarEscritaPolitica(
  dados: EscritaPoliticaJobData,
): Promise<Job<EscritaPoliticaJobData>> {
  return filaEscritaPolitica.add('salvar-politica', dados);
}

// `QueueEvents` só precisa existir quando alguém de fato espera o resultado
// (`executarEscritaPoliticaSincrona`) — instanciado lazy pra não abrir uma
// conexão Redis extra em processos que só enfileiram (ex.: um script batch)
// ou só processam (o worker dedicado).
let eventosFila: QueueEvents | undefined;
function obterEventosFila(): QueueEvents {
  eventosFila ??= new QueueEvents(NOME_FILA_ESCRITA_POLITICA, { connection: conexaoEventos });
  return eventosFila;
}

/**
 * As rotas HTTP de política (Fase 5, `POST`/`PATCH /policies`) precisam do
 * resultado — ou do erro — da escrita antes de responder ao admin (ex.:
 * `enforceInvariants` corrigiu algo? a AMAPI recusou o payload com 400?).
 * `waitUntilFinished` (BullMQ) resolve com o retorno do processador quando
 * o job termina, ou rejeita com o erro que o processador lançou — a rota
 * só precisa fazer `try/catch` em cima disto, sem saber que existe uma fila
 * por trás.
 */
export async function executarEscritaPoliticaSincrona(
  dados: EscritaPoliticaJobData,
  timeoutMs = 30_000,
): Promise<PolicyPayload> {
  const job = await enfileirarEscritaPolitica(dados);
  return job.waitUntilFinished(obterEventosFila(), timeoutMs) as Promise<PolicyPayload>;
}

export type ProcessadorEscritaPolitica = (dados: EscritaPoliticaJobData) => Promise<unknown>;

/**
 * Quem chama passa o `processar` de verdade (que vai importar
 * `salvarPolitica` de `integrations/amapi/policies.ts`) — a fila não sabe
 * nada de AMAPI, só orquestra "um de cada vez, na ordem". Isso mantém a
 * fila testável sem precisar mockar a AMAPI inteira só pra testar que a
 * concorrência 1 funciona (ver `test/integration/policy-write-queue.test.ts`).
 */
export function criarWorkerEscritaPolitica(
  processar: ProcessadorEscritaPolitica,
): Worker<EscritaPoliticaJobData> {
  const worker = new Worker<EscritaPoliticaJobData>(
    NOME_FILA_ESCRITA_POLITICA,
    async (job) => processar(job.data),
    { connection: conexaoWorker, concurrency: 1 },
  );

  worker.on('failed', (job, erro) => {
    logger.error(
      { err: erro, jobId: job?.id, nomePolitica: job?.data.nomePolitica },
      'falha ao processar job de escrita de política',
    );
  });

  return worker;
}

/** Encerramento gracioso — usado no shutdown do processo (server.ts / worker dedicado). */
export async function fecharFilaEscritaPolitica(): Promise<void> {
  await filaEscritaPolitica.close();
  await eventosFila?.close();
  conexaoProducer.disconnect();
  conexaoWorker.disconnect();
  conexaoEventos.disconnect();
}
