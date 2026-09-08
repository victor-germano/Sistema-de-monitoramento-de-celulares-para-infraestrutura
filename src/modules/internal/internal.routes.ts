// Rotas operacionais internas (seção 10, Fase 4) — nunca expostas a
// nenhum papel além de ADMIN; existem pra recuperação manual, não pro uso
// diário de ninguém.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isNull } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { eventosBrutos } from '../../db/schema/eventos-brutos.ts';
import { processarEventoBruto } from '../../domain/eventos/processar-evento.ts';
import { listarDispositivos as listarDispositivosAmapi } from '../../integrations/amapi/devices.ts';
import {
  processarStatusReport,
  DispositivoDesconhecidoError,
} from '../../domain/eventos/handlers/status-report.ts';
import { registrarAuditoria } from '../../domain/auditoria/registrar.ts';
import { executarScanPeriodico } from '../../domain/alertas/motor.ts';
import { purgarEventosBrutosAntigos } from '../../domain/lgpd/retencao.ts';
import { logger } from '../../shared/logger.ts';
import { withRole } from '../../plugins/rbac.ts';

const replayBodySchema = z.object({
  // Sem `ids`: reprocessa todo evento ainda não confirmado (`processado_em`
  // null) — inclui tanto o que falhou quanto o que nunca chegou a ser
  // tentado (`sem_handler` de um tipo que passou a ter handler depois).
  ids: z.array(z.coerce.number().int().positive()).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export function registerInternalRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  // --- POST /internal/pubsub/replay ------------------------------------------
  zodApp.post(
    '/internal/pubsub/replay',
    { ...withRole('ADMIN'), schema: { body: replayBodySchema } },
    async (request, reply) => {
      const idsAlvo = request.body.ids?.length
        ? request.body.ids
        : (
            await db
              .select({ id: eventosBrutos.id })
              .from(eventosBrutos)
              .where(isNull(eventosBrutos.processadoEm))
              .limit(request.body.limit)
          ).map((linha) => linha.id);

      const resultados = { processado: 0, semHandler: 0, erro: 0 };
      const erros: { id: number; mensagem: string }[] = [];

      for (const id of idsAlvo) {
        const resultado = await processarEventoBruto(id);
        if (resultado.status === 'processado') resultados.processado += 1;
        else if (resultado.status === 'sem_handler') resultados.semHandler += 1;
        else {
          resultados.erro += 1;
          erros.push({ id, mensagem: resultado.mensagem });
        }
      }

      await registrarAuditoria(db, {
        ator: { id: request.user!.sub, email: request.user!.email },
        acao: 'PUBSUB_REPLAY',
        entidade: 'eventos_brutos',
        detalhes: { totalTentado: idsAlvo.length, ...resultados },
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.send({ totalTentado: idsAlvo.length, ...resultados, erros });
    },
  );

  // --- POST /internal/sync/devices ---------------------------------------------
  // Reconciliação completa: pagina TODOS os devices da enterprise na AMAPI e
  // aplica o mesmo processamento do `STATUS_REPORT` em cada um — cobre o
  // caso de mensagens Pub/Sub perdidas (não só atraso; perda de verdade,
  // fora do alcance do replay porque nem chegou a virar `eventos_brutos`).
  // Device que a AMAPI conhece mas que nunca passou por `ENROLLMENT` aqui
  // (`DispositivoDesconhecidoError`) é contado, não criado às cegas — criar
  // sem o vínculo de `enrollment_tokens` quebraria a garantia de que todo
  // dispositivo nasce com uma proveniência conhecida (seção 7).
  zodApp.post('/internal/sync/devices', withRole('ADMIN'), async (request, reply) => {
    const resultados = { atualizado: 0, ignoradoSemEnrollment: 0, erro: 0 };
    let pageToken: string | undefined;

    do {
      const pagina = await listarDispositivosAmapi({ pageSize: 100, pageToken });
      for (const device of pagina.dispositivos) {
        try {
          await db.transaction((tx) => processarStatusReport(tx, device));
          resultados.atualizado += 1;
        } catch (erro) {
          if (erro instanceof DispositivoDesconhecidoError) {
            resultados.ignoradoSemEnrollment += 1;
          } else {
            resultados.erro += 1;
            logger.error(
              { err: erro, amapiName: device.name },
              'sync/devices: falha ao reconciliar device',
            );
          }
        }
      }
      pageToken = pagina.proximaPagina;
    } while (pageToken);

    await registrarAuditoria(db, {
      ator: { id: request.user!.sub, email: request.user!.email },
      acao: 'SYNC_DEVICES_FULL',
      entidade: 'dispositivo',
      detalhes: resultados,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.send(resultados);
  });

  // --- POST /internal/alertas/verificar ----------------------------------------
  // Dispara na hora os 3 scans periódicos (SEM_CHECKIN/DISPOSITIVO_ORFAO/
  // LINHA_SEM_USO) que `src/workers/manutencao-worker.ts` roda sozinho a
  // cada `ALERTA_SCAN_INTERVALO_HORAS` — útil pra não esperar o próximo
  // ciclo depois de uma mudança de configuração, ou simplesmente rodar sem
  // o worker dedicado de pé.
  zodApp.post('/internal/alertas/verificar', withRole('ADMIN'), async (request, reply) => {
    const resultado = await executarScanPeriodico();

    await registrarAuditoria(db, {
      ator: { id: request.user!.sub, email: request.user!.email },
      acao: 'ALERTAS_SCAN_MANUAL',
      entidade: 'alerta',
      detalhes: resultado,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.send(resultado);
  });

  // --- POST /internal/lgpd/purgar -----------------------------------------------
  zodApp.post('/internal/lgpd/purgar', withRole('ADMIN'), async (request, reply) => {
    const eventosBrutosPurgados = await purgarEventosBrutosAntigos();

    await registrarAuditoria(db, {
      ator: { id: request.user!.sub, email: request.user!.email },
      acao: 'LGPD_PURGA_MANUAL',
      entidade: 'eventos_brutos',
      detalhes: { eventosBrutosPurgados },
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.send({ eventosBrutosPurgados });
  });
}
