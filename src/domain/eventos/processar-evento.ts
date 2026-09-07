// Núcleo comum de processamento de UM evento cru já gravado em
// `eventos_brutos` — compartilhado entre o consumer em tempo real
// (`src/workers/pubsub-consumer.ts`) e o replay manual
// (`POST /internal/pubsub/replay`, Fase 4, seção 10). Os dois processam a
// mesma linha da mesma forma; o que muda é só o que cada chamador faz
// DEPOIS do resultado (ack/nack de uma `Message` real vs. contagem de
// sucesso/erro numa resposta HTTP).
import { eq } from 'drizzle-orm';
import type { androidmanagement_v1 } from 'googleapis';
import { db } from '../../db/client.ts';
import { eventosBrutos } from '../../db/schema/eventos-brutos.ts';
import { processarEnrollment } from './handlers/enrollment.ts';
import { processarStatusReport } from './handlers/status-report.ts';

type Device = androidmanagement_v1.Schema$Device;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Só os 2 tipos no escopo da Fase 4 (seção 8: os demais — COMMAND,
 * USAGE_LOGS — ficam pra quando comandos/relatórios de uso existirem;
 * `ENTERPRISE_UPGRADE`, seção não lista, ADR-017 — tratado como "sem
 * handler" também).
 */
export const HANDLERS_POR_NOTIFICATION_TYPE: Record<
  string,
  (tx: Tx, resource: Device) => Promise<void>
> = {
  ENROLLMENT: processarEnrollment,
  STATUS_REPORT: processarStatusReport,
};

export type ResultadoProcessamento =
  { status: 'processado' } | { status: 'sem_handler' } | { status: 'erro'; mensagem: string };

export async function processarEventoBruto(eventoBrutoId: number): Promise<ResultadoProcessamento> {
  const [evento] = await db
    .select()
    .from(eventosBrutos)
    .where(eq(eventosBrutos.id, eventoBrutoId))
    .limit(1);
  if (!evento) {
    return { status: 'erro', mensagem: 'evento_bruto não encontrado' };
  }

  const handler = HANDLERS_POR_NOTIFICATION_TYPE[evento.notificationType];
  if (!handler) {
    return { status: 'sem_handler' };
  }

  // `eventos_brutos.payload` grava `{ attributes, data }` (ADR-017) — o
  // handler de domínio só precisa do recurso (`data`), nunca dos attributes
  // brutos da mensagem Pub/Sub.
  const resource = (evento.payload as { data?: unknown } | null)?.data as Device | undefined;
  if (!resource) {
    return {
      status: 'erro',
      mensagem:
        'payload sem campo `data` — evento gravado antes do formato { attributes, data } (ADR-017)',
    };
  }

  try {
    await db.transaction(async (tx) => {
      await handler(tx, resource);
      await tx
        .update(eventosBrutos)
        .set({ processadoEm: new Date(), erro: null })
        .where(eq(eventosBrutos.id, evento.id));
    });
    return { status: 'processado' };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    // Fora da transação de cima (que já deu rollback) — o registro do erro
    // precisa sobreviver mesmo com o resto do processamento revertido.
    await db.update(eventosBrutos).set({ erro: mensagem }).where(eq(eventosBrutos.id, evento.id));
    return { status: 'erro', mensagem };
  }
}
