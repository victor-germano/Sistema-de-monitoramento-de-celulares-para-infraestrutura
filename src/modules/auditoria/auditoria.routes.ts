// ADR-004: único ponto de acesso do papel AUDITOR à trilha de auditoria —
// visão global, filtrável por entidade/entidade_id quando precisar do
// histórico de uma coisa específica. `AUDITOR` não acessa nenhuma rota sob
// `/devices/*`, nem `GET /devices/:id/auditoria` (mesma trilha, mas por
// dispositivo) — só esta.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listarAuditoria } from '../../domain/auditoria/registrar.ts';
import { withRole } from '../../plugins/rbac.ts';

const querySchema = z.object({
  entidade: z.string().optional(),
  entidadeId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.coerce.number().int().positive().optional(),
});

export function registerAuditoriaRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  zodApp.get(
    '/auditoria',
    { ...withRole('ADMIN', 'AUDITOR'), schema: { querystring: querySchema } },
    async (request, reply) => {
      return reply.send(await listarAuditoria(request.query));
    },
  );
}
