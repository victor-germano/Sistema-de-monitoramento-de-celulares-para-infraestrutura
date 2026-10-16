// Resumo agregado da frota (seção 10, Fase 6) — pensado pra alimentar a tela
// inicial do painel que outra equipe constrói. `AUDITOR` incluído (mesma
// razão do `/alertas` — `compliance:ler`, ADR-028): um resumo é
// exatamente o tipo de visão de compliance que esse papel deveria enxergar.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { obterResumoDashboard } from '../../domain/dashboard/repositorio.ts';
import { gerarPlanilhaDashboard } from '../../domain/dashboard/exportar-excel.ts';
import { withRole } from '../../plugins/rbac.ts';

// Achado numa revisão: `new Date().toISOString()` é sempre UTC — entre
// 21h00 e 23h59 no horário do Grupo Roveri (America/Sao_Paulo, UTC-3), já é
// o dia seguinte em UTC, e o arquivo baixado vinha com a data de amanhã no
// nome. `toLocaleDateString('en-CA', { timeZone: ... })` devolve
// diretamente no formato AAAA-MM-DD (convenção da locale `en-CA`), já no
// fuso certo, sem precisar de biblioteca de data nova.
export function dataDeHojeNoFusoDaEmpresa(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

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
      const data = dataDeHojeNoFusoDaEmpresa();

      return reply
        .header('Content-Disposition', `attachment; filename="dashboard-mdm-${data}.xlsx"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(planilha);
    },
  );
}
