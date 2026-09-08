// Resumo agregado da frota (seção 10, Fase 6) — pensado pra alimentar a tela
// inicial do painel que outra equipe constrói. `AUDITOR` incluído (mesma
// razão do `/alertas` — `compliance:ler`, ADR-028): um resumo é
// exatamente o tipo de visão de compliance que esse papel deveria enxergar.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { obterResumoDashboard } from '../../domain/dashboard/repositorio.ts';
import { withRole } from '../../plugins/rbac.ts';

export function registerDashboardRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  zodApp.get(
    '/dashboard',
    withRole('VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'),
    async (_request, reply) => {
      return reply.send(await obterResumoDashboard());
    },
  );
}
