// Consulta e ciclo de vida manual de alertas (seção 9, Fase 6). Abertura é
// sempre automática (motor de alertas — reativo em `status-report.ts`,
// periódico em `src/workers/manutencao-worker.ts`); estas rotas só leem e
// permitem reconhecer/resolver manualmente.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { alertaTipoEnum, alertaSeveridadeEnum } from '../../db/schema/alertas.ts';
import {
  buscarAlertaPorId,
  listarAlertas,
  reconhecerAlerta,
  resolverAlertaManualmente,
} from '../../domain/alertas/repositorio.ts';
import { registrarAuditoria } from '../../domain/auditoria/registrar.ts';
import { db } from '../../db/client.ts';
import { sendProblem } from '../../shared/problem-details.ts';
import { zQueryBoolean } from '../../shared/zod-query.ts';
import { withRole } from '../../plugins/rbac.ts';

const paramsIdSchema = z.object({ id: z.string().uuid() });

const listarQuerySchema = z.object({
  dispositivoId: z.string().uuid().optional(),
  tipo: z.enum(alertaTipoEnum.enumValues).optional(),
  severidade: z.enum(alertaSeveridadeEnum.enumValues).optional(),
  aberto: zQueryBoolean.optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().uuid().optional(),
});

// `AUDITOR` INCLUÍDO aqui, ao contrário de `/devices/*` (ADR-004) — a lista
// de permissões da seção 5 já declara `compliance:ler` pro papel desde a
// Fase 2 (`src/domain/auth/permissions.ts`), e boa parte dos alertas
// (NAO_CONFORME, PATCH_DESATUALIZADO, SO_OBSOLETO) É sinal de compliance,
// não inventário operacional (ver ADR-028).
const ROLES_LEITURA = ['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'] as const;

export function registerAlertaRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  zodApp.get(
    '/alertas',
    { ...withRole(...ROLES_LEITURA), schema: { querystring: listarQuerySchema } },
    async (request, reply) => reply.send(await listarAlertas(request.query)),
  );

  zodApp.get(
    '/alertas/:id',
    { ...withRole(...ROLES_LEITURA), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const alerta = await buscarAlertaPorId(request.params.id);
      if (!alerta) return sendProblem(reply, 404, 'Alerta não encontrado', undefined);
      return reply.send(alerta);
    },
  );

  zodApp.post(
    '/alertas/:id/reconhecer',
    { ...withRole('TECNICO', 'ADMIN'), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const alerta = await reconhecerAlerta(request.params.id, request.user!.sub);
      if (!alerta) return sendProblem(reply, 404, 'Alerta não encontrado', undefined);

      await registrarAuditoria(db, {
        ator: { id: request.user!.sub, email: request.user!.email },
        acao: 'ALERTA_RECONHECIDO',
        entidade: 'alerta',
        entidadeId: alerta.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return reply.send(alerta);
    },
  );

  zodApp.post(
    '/alertas/:id/resolver',
    { ...withRole('TECNICO', 'ADMIN'), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const alerta = await resolverAlertaManualmente(request.params.id);
      if (!alerta) return sendProblem(reply, 404, 'Alerta não encontrado', undefined);

      await registrarAuditoria(db, {
        ator: { id: request.user!.sub, email: request.user!.email },
        acao: 'ALERTA_RESOLVIDO_MANUALMENTE',
        entidade: 'alerta',
        entidadeId: alerta.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return reply.send(alerta);
    },
  );
}
