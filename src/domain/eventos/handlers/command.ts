// Handler do `notificationType: 'COMMAND'` (seção 8, Fase 5 — ficou "sem
// handler" desde a Fase 4, por escopo). `issueCommand` (seção 7,
// `src/integrations/amapi/commands.ts`) devolve uma `Operation` assíncrona;
// este handler é quem sabe o resultado FINAL, quando a AMAPI publica o
// evento depois que o comando termina (ou falha) no device.
import { eq } from 'drizzle-orm';
import type { androidmanagement_v1 } from 'googleapis';
import type { db } from '../../../db/client.ts';
import { comandos } from '../../../db/schema/comandos.ts';
import { logger } from '../../../shared/logger.ts';

type Operation = androidmanagement_v1.Schema$Operation;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Correlação por `amapi_operation_name` (gravado no momento da emissão —
 * `POST /devices/:id/comandos`, Fase 5). `Operation.name` é o único campo
 * comum entre o que `issueCommand` devolveu e o que este evento traz.
 *
 * `done: false` (comando ainda em andamento no device) não atualiza nada —
 * o registro já nasceu `ENVIADO` na emissão; só um `done: true` (com ou sem
 * `error`) representa um resultado final.
 */
export async function processarCommand(tx: Tx, operation: Operation): Promise<void> {
  if (!operation.name) {
    logger.warn('COMMAND: operation sem name, ignorando');
    return;
  }
  if (!operation.done) {
    return;
  }

  const [comando] = await tx
    .select()
    .from(comandos)
    .where(eq(comandos.amapiOperationName, operation.name))
    .limit(1);
  if (!comando) {
    logger.warn(
      { operationName: operation.name },
      'COMMAND: nenhum comando correlacionado — ignorando',
    );
    return;
  }

  await tx
    .update(comandos)
    .set({
      status: operation.error ? 'FALHA' : 'SUCESSO',
      // `null`, nunca `undefined` — o driver `postgres` rejeita `undefined`
      // como parâmetro de bind ("Undefined values are not allowed"); `null`
      // é o jeito correto de expressar "sem erro" numa coluna nullable.
      erro: operation.error?.message ?? null,
      concluidoEm: new Date(),
    })
    .where(eq(comandos.id, comando.id));

  logger.info({ comandoId: comando.id, sucesso: !operation.error }, 'COMMAND: comando concluído');
}
