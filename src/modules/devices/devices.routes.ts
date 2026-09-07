// Rotas de leitura/vínculo de dispositivos — seção 10, Fase 4. Emissão de
// comando (`POST /devices/:id/comandos`) e troca de política ficam pra Fase
// 5; aqui só existe o que a Fase 4 entrega: inventário populado por
// ENROLLMENT/STATUS_REPORT e o vínculo administrativo (`PATCH`).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  atualizarVinculoDispositivo,
  buscarDispositivoPorId,
  listarAppsDoDispositivo,
  listarDispositivos,
} from '../../domain/dispositivos/repositorio.ts';
import { listarComandosDoDispositivo } from '../../domain/comandos/repositorio.ts';
import {
  listarAuditoriaPorEntidade,
  registrarAuditoria,
} from '../../domain/auditoria/registrar.ts';
import { db } from '../../db/client.ts';
import { sendProblem } from '../../shared/problem-details.ts';
import { withRole } from '../../plugins/rbac.ts';

const paramsIdSchema = z.object({ id: z.string().uuid() });

// Todos os filtros são opcionais e livres o bastante pra cobrir os casos da
// seção 10 ("filtrar por filial, departamento, compliance, política,
// colaborador, texto livre, dias sem check-in") sem já fixar quais telas o
// frontend vai construir em cima disso.
const listarQuerySchema = z.object({
  filial: z.string().optional(),
  departamento: z.string().optional(),
  complianceState: z.string().optional(),
  politicaId: z.string().uuid().optional(),
  colaboradorId: z.string().uuid().optional(),
  busca: z.string().optional(),
  semCheckinDias: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().uuid().optional(),
});

const patchBodySchema = z.object({
  colaboradorId: z.string().uuid().nullable().optional(),
  linhaId: z.string().uuid().nullable().optional(),
  patrimonio: z.string().nullable().optional(),
  ativo: z.boolean().optional(),
});

const listarSubrecursoQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

// ADR-004 (confirmado com o Victor em 2026-09-04): `AUDITOR` não acessa
// NENHUMA rota sob `/devices/*`, nem as de leitura — inclusive
// `/devices/:id/auditoria`. O único acesso do papel a trilha de auditoria é
// `GET /auditoria` (visão global, filtrável), não esta rota por dispositivo.
const ROLES_LEITURA = ['VIEWER', 'TECNICO', 'ADMIN'] as const;

export function registerDeviceRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  // --- GET /devices ------------------------------------------------------
  zodApp.get(
    '/devices',
    { ...withRole(...ROLES_LEITURA), schema: { querystring: listarQuerySchema } },
    async (request, reply) => {
      const pagina = await listarDispositivos(request.query);
      return reply.send(pagina);
    },
  );

  // --- GET /devices/:id ----------------------------------------------------
  zodApp.get(
    '/devices/:id',
    { ...withRole(...ROLES_LEITURA), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const dispositivo = await buscarDispositivoPorId(request.params.id);
      if (!dispositivo) {
        return sendProblem(reply, 404, 'Dispositivo não encontrado', undefined);
      }
      return reply.send(dispositivo);
    },
  );

  // --- PATCH /devices/:id --------------------------------------------------
  // Só o vínculo administrativo (colaborador/linha/patrimônio/ativo) —
  // seção 10. Nada aqui toca a AMAPI; é dado só nosso, sobre o dispositivo.
  zodApp.patch(
    '/devices/:id',
    {
      ...withRole('TECNICO', 'ADMIN'),
      schema: { params: paramsIdSchema, body: patchBodySchema },
    },
    async (request, reply) => {
      const dispositivo = await atualizarVinculoDispositivo(request.params.id, request.body);
      if (!dispositivo) {
        return sendProblem(reply, 404, 'Dispositivo não encontrado', undefined);
      }

      await registrarAuditoria(db, {
        ator: { id: request.user!.sub, email: request.user!.email },
        acao: 'DISPOSITIVO_VINCULO_ALTERADO',
        entidade: 'dispositivo',
        entidadeId: dispositivo.id,
        detalhes: request.body,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.send(dispositivo);
    },
  );

  // --- GET /devices/:id/apps ------------------------------------------------
  zodApp.get(
    '/devices/:id/apps',
    { ...withRole(...ROLES_LEITURA), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const dispositivo = await buscarDispositivoPorId(request.params.id);
      if (!dispositivo) {
        return sendProblem(reply, 404, 'Dispositivo não encontrado', undefined);
      }
      return reply.send(await listarAppsDoDispositivo(db, dispositivo.id));
    },
  );

  // --- GET /devices/:id/comandos ---------------------------------------------
  // Só leitura do histórico — emitir comando é `POST` na Fase 5.
  zodApp.get(
    '/devices/:id/comandos',
    {
      ...withRole(...ROLES_LEITURA),
      schema: { params: paramsIdSchema, querystring: listarSubrecursoQuerySchema },
    },
    async (request, reply) => {
      const dispositivo = await buscarDispositivoPorId(request.params.id);
      if (!dispositivo) {
        return sendProblem(reply, 404, 'Dispositivo não encontrado', undefined);
      }
      return reply.send(await listarComandosDoDispositivo(dispositivo.id, request.query.limit));
    },
  );

  // --- GET /devices/:id/auditoria ---------------------------------------------
  zodApp.get(
    '/devices/:id/auditoria',
    {
      ...withRole(...ROLES_LEITURA),
      schema: { params: paramsIdSchema, querystring: listarSubrecursoQuerySchema },
    },
    async (request, reply) => {
      const dispositivo = await buscarDispositivoPorId(request.params.id);
      if (!dispositivo) {
        return sendProblem(reply, 404, 'Dispositivo não encontrado', undefined);
      }
      return reply.send(
        await listarAuditoriaPorEntidade('dispositivo', dispositivo.id, request.query.limit),
      );
    },
  );
}
