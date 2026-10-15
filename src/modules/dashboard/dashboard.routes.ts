// Resumo agregado da frota (seção 10, Fase 6) — pensado pra alimentar a tela
// inicial do painel que outra equipe constrói. `AUDITOR` incluído (mesma
// razão do `/alertas` — `compliance:ler`, ADR-028): um resumo é
// exatamente o tipo de visão de compliance que esse papel deveria enxergar.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { obterResumoDashboard } from '../../domain/dashboard/repositorio.ts';
import { gerarPlanilhaDashboard } from '../../domain/dashboard/exportar-excel.ts';
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

  // Mesmo RBAC do `/dashboard` (mesma permissão `compliance:ler`, ADR-028) —
  // é o mesmo dado, só em outro formato. Sem schema de `response` Zod de
  // propósito: o corpo é binário (.xlsx), não JSON — declarar um schema aqui
  // faria o serializer global tentar validar/serializar o Buffer como se
  // fosse o shape de `ResumoDashboard`.
  zodApp.get(
    '/dashboard/export',
    withRole('VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'),
    async (_request, reply) => {
      const resumo = await obterResumoDashboard();
      const planilha = await gerarPlanilhaDashboard(resumo);
      const dataIso = new Date().toISOString().slice(0, 10);

      return reply
        .header('Content-Disposition', `attachment; filename="dashboard-mdm-${dataIso}.xlsx"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(planilha);
    },
  );
}
