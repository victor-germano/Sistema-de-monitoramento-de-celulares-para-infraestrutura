// CRUD de linhas telefônicas (seção 6/10) — mesma filosofia de RBAC de
// colaboradores: `AUDITOR` fica de fora (ADR-004).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  atualizarLinha,
  buscarLinhaPorId,
  buscarLinhaPorNumero,
  criarLinha,
  listarLinhas,
} from '../../domain/linhas/repositorio.ts';
import { registrarAuditoria } from '../../domain/auditoria/registrar.ts';
import { db } from '../../db/client.ts';
import { sendProblem } from '../../shared/problem-details.ts';
import { withRole } from '../../plugins/rbac.ts';

const paramsIdSchema = z.object({ id: z.string().uuid() });

const statusSchema = z.enum(['ativa', 'suspensa', 'cancelada']);

const listarQuerySchema = z.object({
  status: statusSchema.optional(),
  operadora: z.string().optional(),
  busca: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().uuid().optional(),
});

const criarBodySchema = z.object({
  numero: z.string().min(1),
  // Texto livre, sem lista fechada — decisão do Victor (2026-09-04, ADR-005).
  operadora: z.string().optional(),
  iccid: z.string().optional(),
  planoDadosGb: z.coerce.number().int().nonnegative().optional(),
  valorMensal: z.coerce.number().nonnegative().optional(),
  dataAtivacao: z.string().date().optional(),
  observacoes: z.string().optional(),
});

const atualizarBodySchema = criarBodySchema
  .omit({ numero: true })
  .partial()
  .extend({ status: statusSchema.optional() });

const ROLES_LEITURA = ['VIEWER', 'TECNICO', 'ADMIN'] as const;

// A coluna `valor_mensal` é `numeric` (Postgres) — o driver representa isso
// como `string` (evita imprecisão de ponto flutuante em dinheiro), não
// `number`. O corpo da requisição chega validado como `number` (mais
// natural pro cliente da API); a conversão fica aqui, na borda, não
// espalhada pelo repositório.
function comValorMensalComoString<T extends { valorMensal?: number }>(
  body: T,
): Omit<T, 'valorMensal'> & { valorMensal?: string } {
  const { valorMensal, ...resto } = body;
  return { ...resto, valorMensal: valorMensal !== undefined ? valorMensal.toString() : undefined };
}

// Contraparte de `comValorMensalComoString`, pra SAÍDA: sem isso, toda
// resposta de `/linhas` devolvia `valorMensal` como a string crua do driver
// Postgres (ex. "89.90") em vez do número que docs/api/colaboradores-e-
// linhas.md promete — achado numa revisão de segurança/correção (o teste de
// integração antigo até travava o bug como esperado, `.toBe('89.90')`).
function comValorMensalComoNumero<T extends { valorMensal: string | null }>(
  linha: T,
): Omit<T, 'valorMensal'> & { valorMensal: number | null } {
  const { valorMensal, ...resto } = linha;
  return { ...resto, valorMensal: valorMensal === null ? null : Number(valorMensal) };
}

export function registerLinhaRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  zodApp.get(
    '/linhas',
    { ...withRole(...ROLES_LEITURA), schema: { querystring: listarQuerySchema } },
    async (request, reply) => {
      const pagina = await listarLinhas(request.query);
      return reply.send({ ...pagina, itens: pagina.itens.map(comValorMensalComoNumero) });
    },
  );

  zodApp.get(
    '/linhas/:id',
    { ...withRole(...ROLES_LEITURA), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const linha = await buscarLinhaPorId(request.params.id);
      if (!linha) return sendProblem(reply, 404, 'Linha não encontrada', undefined);
      return reply.send(comValorMensalComoNumero(linha));
    },
  );

  zodApp.post(
    '/linhas',
    { ...withRole('TECNICO', 'ADMIN'), schema: { body: criarBodySchema } },
    async (request, reply) => {
      if (await buscarLinhaPorNumero(request.body.numero)) {
        return sendProblem(reply, 409, 'Número já cadastrado', undefined);
      }

      const linha = await criarLinha(comValorMensalComoString(request.body));
      await registrarAuditoria(db, {
        ator: { id: request.user!.sub, email: request.user!.email },
        acao: 'LINHA_CRIADA',
        entidade: 'linha',
        entidadeId: linha.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return reply.status(201).send(comValorMensalComoNumero(linha));
    },
  );

  zodApp.patch(
    '/linhas/:id',
    {
      ...withRole('TECNICO', 'ADMIN'),
      schema: { params: paramsIdSchema, body: atualizarBodySchema },
    },
    async (request, reply) => {
      const linha = await atualizarLinha(request.params.id, comValorMensalComoString(request.body));
      if (!linha) return sendProblem(reply, 404, 'Linha não encontrada', undefined);

      await registrarAuditoria(db, {
        ator: { id: request.user!.sub, email: request.user!.email },
        acao: 'LINHA_ATUALIZADA',
        entidade: 'linha',
        entidadeId: linha.id,
        detalhes: request.body,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return reply.send(comValorMensalComoNumero(linha));
    },
  );
}
