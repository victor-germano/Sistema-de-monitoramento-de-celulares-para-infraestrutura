// CRUD de colaboradores (seção 6/10) — dado de contexto organizacional, não
// operacional-de-frota; mesmo assim `AUDITOR` fica de fora (mesma filosofia
// do ADR-004: papel só enxerga `GET /auditoria`, não inventário nenhum).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  atualizarColaborador,
  buscarColaboradorPorId,
  buscarColaboradorPorMatricula,
  criarColaborador,
  listarColaboradores,
} from '../../domain/colaboradores/repositorio.ts';
import { registrarAuditoria } from '../../domain/auditoria/registrar.ts';
import { db } from '../../db/client.ts';
import { sendProblem } from '../../shared/problem-details.ts';
import { withRole } from '../../plugins/rbac.ts';

const paramsIdSchema = z.object({ id: z.string().uuid() });

const listarQuerySchema = z.object({
  filial: z.string().optional(),
  departamento: z.string().optional(),
  ativo: z.coerce.boolean().optional(),
  busca: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().uuid().optional(),
});

const criarBodySchema = z.object({
  matricula: z.string().min(1),
  nome: z.string().min(1),
  email: z.string().email().optional(),
  filial: z.string().optional(),
  departamento: z.string().optional(),
  centroCusto: z.string().optional(),
});

// `matricula` fora do PATCH de propósito: é o identificador natural
// (unique index) — renomear sem tratamento de conflito devolveria um 500 de
// constraint em vez de um 409 amigável. Recriar o registro é o caminho
// pra uma matrícula errada, não uma implementação de PATCH mais complexa
// sem pedido explícito pra isso.
const atualizarBodySchema = criarBodySchema
  .omit({ matricula: true })
  .partial()
  .extend({ ativo: z.boolean().optional() });

const ROLES_LEITURA = ['VIEWER', 'TECNICO', 'ADMIN'] as const;

export function registerColaboradorRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  zodApp.get(
    '/colaboradores',
    { ...withRole(...ROLES_LEITURA), schema: { querystring: listarQuerySchema } },
    async (request, reply) => reply.send(await listarColaboradores(request.query)),
  );

  zodApp.get(
    '/colaboradores/:id',
    { ...withRole(...ROLES_LEITURA), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const colaborador = await buscarColaboradorPorId(request.params.id);
      if (!colaborador) return sendProblem(reply, 404, 'Colaborador não encontrado', undefined);
      return reply.send(colaborador);
    },
  );

  zodApp.post(
    '/colaboradores',
    { ...withRole('TECNICO', 'ADMIN'), schema: { body: criarBodySchema } },
    async (request, reply) => {
      if (await buscarColaboradorPorMatricula(request.body.matricula)) {
        return sendProblem(reply, 409, 'Matrícula já cadastrada', undefined);
      }

      const colaborador = await criarColaborador(request.body);
      await registrarAuditoria(db, {
        ator: { id: request.user!.sub, email: request.user!.email },
        acao: 'COLABORADOR_CRIADO',
        entidade: 'colaborador',
        entidadeId: colaborador.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return reply.status(201).send(colaborador);
    },
  );

  zodApp.patch(
    '/colaboradores/:id',
    {
      ...withRole('TECNICO', 'ADMIN'),
      schema: { params: paramsIdSchema, body: atualizarBodySchema },
    },
    async (request, reply) => {
      const colaborador = await atualizarColaborador(request.params.id, request.body);
      if (!colaborador) return sendProblem(reply, 404, 'Colaborador não encontrado', undefined);

      await registrarAuditoria(db, {
        ator: { id: request.user!.sub, email: request.user!.email },
        acao: 'COLABORADOR_ATUALIZADO',
        entidade: 'colaborador',
        entidadeId: colaborador.id,
        detalhes: request.body,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return reply.send(colaborador);
    },
  );
}
