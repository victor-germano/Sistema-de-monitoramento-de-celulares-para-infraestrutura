// CRUD de políticas (seção 7/10, Fase 5) — rotas HTTP em cima do adapter e
// da fila serializada que a Fase 3 já deixou prontos como biblioteca
// interna. Toda escrita passa por `executarEscritaPoliticaSincrona`
// (nunca `salvarPolitica` direto) — é isso que garante concorrência 1 de
// verdade contra a AMAPI, mesmo com vários processos de API atrás de um
// load balancer.
import { and, desc, eq, ilike } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../../db/client.ts';
import { politicas, politicasVersoes } from '../../db/schema/politicas.ts';
import { dispositivos } from '../../db/schema/dispositivos.ts';
import { nomeEnterprise } from '../../integrations/amapi/client.ts';
import { excluirPolitica, type PolicyPayload } from '../../integrations/amapi/policies.ts';
import {
  executarEscritaPoliticaSincrona,
  EscritaPoliticaTimeoutError,
} from '../../queues/policy-write-queue.ts';
import { aplicarInvariantesComAuditoria } from '../../domain/policy/policy-invariants.ts';
import { registrarAuditoria } from '../../domain/auditoria/registrar.ts';
import { sendProblem } from '../../shared/problem-details.ts';
import { logger } from '../../shared/logger.ts';
import { zQueryBoolean } from '../../shared/zod-query.ts';
import { escaparTermoBusca } from '../../shared/sql-like.ts';
import { withRole } from '../../plugins/rbac.ts';

// Corpo do payload é o `Policy` inteiro da AMAPI — schema tão grande e
// variável (seção 7) que validar campo a campo aqui duplicaria o que a
// própria AMAPI já valida no `policies.patch`. `enforceInvariants` (chamado
// abaixo, sempre) é a única validação que É nossa responsabilidade.
const payloadPolicySchema = z.record(z.string(), z.unknown());

const paramsIdSchema = z.object({ id: z.string().uuid() });

const criarPoliticaBodySchema = z.object({
  nome: z.string().min(1),
  descricao: z.string().optional(),
  payload: payloadPolicySchema,
});

const atualizarPoliticaBodySchema = z.object({
  descricao: z.string().optional(),
  ativa: z.boolean().optional(),
  payload: payloadPolicySchema.optional(),
});

const rollbackBodySchema = z.object({ versao: z.coerce.number().int().positive() });

const listarQuerySchema = z.object({
  busca: z.string().optional(),
  ativa: zQueryBoolean.optional(),
});

const ROLES_LEITURA = ['VIEWER', 'TECNICO', 'ADMIN'] as const;

/**
 * Aplica os invariantes ANTES de gravar/enviar, e audita quando algo
 * precisou ser corrigido — é o uso concreto de `aplicarInvariantesComAuditoria`
 * (em vez do wrapper `enforceInvariants`) que o comentário de
 * `policy-invariants.ts` já previa pra esta fase.
 */
async function aplicarInvariantesEAuditar(
  payload: PolicyPayload,
  politicaId: string,
  ator: { id: string; email: string },
  ip?: string,
  userAgent?: string,
): Promise<PolicyPayload> {
  const { policy, overrides } = aplicarInvariantesComAuditoria(payload);
  if (overrides.length > 0) {
    await registrarAuditoria(db, {
      ator,
      acao: 'POLITICA_INVARIANT_OVERRIDE',
      entidade: 'politica',
      entidadeId: politicaId,
      detalhes: { overrides },
      ip,
      userAgent,
    });
  }
  return policy;
}

/**
 * Responde ao timeout da escrita (`EscritaPoliticaTimeoutError`) — nunca
 * trata como falha confirmada, porque não é: o job continua rodando em
 * segundo plano (ver `aposTimeout` passado a `executarEscritaPoliticaSincrona`
 * em cada rota, responsável por persistir o resultado real quando chegar).
 */
function respostaDeTimeout(
  reply: FastifyReply,
  politicaId: string,
  erro: EscritaPoliticaTimeoutError,
) {
  logger.warn(
    { err: erro, politicaId },
    'timeout esperando escrita de política — resultado real será reconciliado quando o job terminar',
  );
  return reply.status(202).send({
    politicaId,
    status: 'processando',
    mensagem: erro.message,
  });
}

/**
 * UPDATE da política + INSERT em `politicas_versoes` + auditoria numa
 * transação SÓ — achado numa revisão: antes eram 3 awaits sequenciais sem
 * transação; uma falha entre eles deixava a política reportando payload/
 * versão novos sem a linha de histórico correspondente (quebra a garantia
 * append-only de `politicas_versoes`).
 */
async function persistirPoliticaNovaAposSucesso(
  politicaId: string,
  amapiName: string,
  payloadFinal: PolicyPayload,
  ator: { id: string; email: string },
  ip: string | undefined,
  userAgent: string | undefined,
) {
  return db.transaction(async (tx) => {
    const [atualizada] = await tx
      .update(politicas)
      .set({ amapiName, payload: payloadFinal })
      .where(eq(politicas.id, politicaId))
      .returning();
    if (!atualizada) throw new Error('política não encontrada ao persistir criação bem-sucedida');
    await tx.insert(politicasVersoes).values({
      politicaId,
      versao: 1,
      payload: payloadFinal,
      criadoPor: ator.id,
    });
    await registrarAuditoria(tx, {
      ator,
      acao: 'POLITICA_CRIADA',
      entidade: 'politica',
      entidadeId: politicaId,
      ip,
      userAgent,
    });
    return atualizada;
  });
}

/**
 * Desfaz o INSERT especulativo (sem `politicas_versoes` gravado ainda,
 * apagar aqui não deixa histórico órfão) — uma política só existe pra valer
 * quando existe nos dois lados (nosso banco E a AMAPI).
 */
async function persistirFalhaPoliticaNova(politicaId: string, erro: unknown): Promise<void> {
  await db.delete(politicas).where(eq(politicas.id, politicaId));
  logger.error({ err: erro, politicaId }, 'falha ao enviar política nova pra AMAPI');
}

/** Mesmo princípio de `persistirPoliticaNovaAposSucesso`, pro PATCH (sem `amapiName` novo). */
async function persistirPoliticaAtualizadaAposSucesso(
  politicaId: string,
  novaVersao: number,
  payloadFinal: PolicyPayload,
  camposAdministrativos: { descricao?: string | null; ativa?: boolean },
  ator: { id: string; email: string },
  ip: string | undefined,
  userAgent: string | undefined,
) {
  return db.transaction(async (tx) => {
    const [atualizada] = await tx
      .update(politicas)
      .set({ ...camposAdministrativos, payload: payloadFinal, versao: novaVersao })
      .where(eq(politicas.id, politicaId))
      .returning();
    if (!atualizada)
      throw new Error('política não encontrada ao persistir atualização bem-sucedida');
    await tx.insert(politicasVersoes).values({
      politicaId,
      versao: novaVersao,
      payload: payloadFinal,
      criadoPor: ator.id,
    });
    await registrarAuditoria(tx, {
      ator,
      acao: 'POLITICA_ATUALIZADA',
      entidade: 'politica',
      entidadeId: politicaId,
      detalhes: { versao: novaVersao },
      ip,
      userAgent,
    });
    return atualizada;
  });
}

/** Mesmo princípio, pro rollback (histórico marcado com `diffResumo`). */
async function persistirRollbackAposSucesso(
  politicaId: string,
  novaVersao: number,
  payloadFinal: PolicyPayload,
  versaoRestaurada: number,
  ator: { id: string; email: string },
  ip: string | undefined,
  userAgent: string | undefined,
) {
  return db.transaction(async (tx) => {
    const [atualizada] = await tx
      .update(politicas)
      .set({ payload: payloadFinal, versao: novaVersao })
      .where(eq(politicas.id, politicaId))
      .returning();
    if (!atualizada) throw new Error('política não encontrada ao persistir rollback bem-sucedido');
    await tx.insert(politicasVersoes).values({
      politicaId,
      versao: novaVersao,
      payload: payloadFinal,
      diffResumo: `rollback pra versão ${versaoRestaurada}`,
      criadoPor: ator.id,
    });
    await registrarAuditoria(tx, {
      ator,
      acao: 'POLITICA_ROLLBACK',
      entidade: 'politica',
      entidadeId: politicaId,
      detalhes: { versaoRestaurada, novaVersao },
      ip,
      userAgent,
    });
    return atualizada;
  });
}

export function registerPoliticaRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  // --- GET /policies -------------------------------------------------------
  zodApp.get(
    '/policies',
    { ...withRole(...ROLES_LEITURA), schema: { querystring: listarQuerySchema } },
    async (request, reply) => {
      const condicoes = [];
      if (request.query.busca) {
        condicoes.push(ilike(politicas.nome, `%${escaparTermoBusca(request.query.busca)}%`));
      }
      if (request.query.ativa !== undefined)
        condicoes.push(eq(politicas.ativa, request.query.ativa));

      const linhas = await db
        .select()
        .from(politicas)
        .where(condicoes.length > 0 ? and(...condicoes) : undefined)
        .orderBy(politicas.nome);
      return reply.send(linhas);
    },
  );

  // --- GET /policies/:id -----------------------------------------------------
  zodApp.get(
    '/policies/:id',
    { ...withRole(...ROLES_LEITURA), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const [politica] = await db
        .select()
        .from(politicas)
        .where(eq(politicas.id, request.params.id))
        .limit(1);
      if (!politica) return sendProblem(reply, 404, 'Política não encontrada', undefined);
      return reply.send(politica);
    },
  );

  // --- GET /policies/:id/versoes -----------------------------------------------
  zodApp.get(
    '/policies/:id/versoes',
    { ...withRole(...ROLES_LEITURA), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const linhas = await db
        .select()
        .from(politicasVersoes)
        .where(eq(politicasVersoes.politicaId, request.params.id))
        .orderBy(desc(politicasVersoes.versao));
      return reply.send(linhas);
    },
  );

  // --- POST /policies --------------------------------------------------------
  zodApp.post(
    '/policies',
    { ...withRole('ADMIN'), schema: { body: criarPoliticaBodySchema } },
    async (request, reply) => {
      const ator = { id: request.user!.sub, email: request.user!.email };
      const existente = await db.query.politicas.findFirst({
        where: (p, { eq: eqOp }) => eqOp(p.nome, request.body.nome),
      });
      if (existente) {
        return sendProblem(reply, 409, 'Já existe uma política com este nome', undefined);
      }

      const [politica] = await db
        .insert(politicas)
        .values({
          nome: request.body.nome,
          descricao: request.body.descricao,
          payload: request.body.payload,
          versao: 1,
          ativa: true,
          criadoPor: ator.id,
        })
        .returning();
      if (!politica) throw new Error('falha ao criar política — insert não retornou linha');

      // Nome do recurso AMAPI é upsert por design (seção 7): usamos o
      // próprio UUID local como o `policyId` do recurso — nunca precisa
      // "reservar" um nome antes de existir localmente.
      const amapiName = `${nomeEnterprise()}/policies/${politica.id}`;
      const payloadCorrigido = await aplicarInvariantesEAuditar(
        request.body.payload,
        politica.id,
        ator,
        request.ip,
        request.headers['user-agent'],
      );

      const ip = request.ip;
      const userAgent = request.headers['user-agent'];

      try {
        const payloadFinal = await executarEscritaPoliticaSincrona(
          { nomePolitica: amapiName, payload: payloadCorrigido },
          {
            // Reconciliação tardia: se o timeout disparar mas o job
            // terminar depois (sucesso OU falha), persiste do mesmo jeito
            // que persistiria se tivesse dado tempo — nunca deixa uma
            // política real na AMAPI sem registro local (ADR-023 na
            // direção inversa), nem o INSERT especulativo órfão pra sempre.
            aposTimeout: (resultado) => {
              if (resultado.status === 'sucesso') {
                void persistirPoliticaNovaAposSucesso(
                  politica.id,
                  amapiName,
                  resultado.payload,
                  ator,
                  ip,
                  userAgent,
                );
              } else {
                void persistirFalhaPoliticaNova(politica.id, resultado.erro);
              }
            },
          },
        );
        const politicaAtualizada = await persistirPoliticaNovaAposSucesso(
          politica.id,
          amapiName,
          payloadFinal,
          ator,
          ip,
          userAgent,
        );
        return reply.status(201).send(politicaAtualizada);
      } catch (erro) {
        if (erro instanceof EscritaPoliticaTimeoutError) {
          return respostaDeTimeout(reply, politica.id, erro);
        }
        await persistirFalhaPoliticaNova(politica.id, erro);
        return sendProblem(reply, 502, 'Falha ao salvar política na AMAPI', String(erro));
      }
    },
  );

  // --- PATCH /policies/:id -----------------------------------------------------
  zodApp.patch(
    '/policies/:id',
    { ...withRole('ADMIN'), schema: { params: paramsIdSchema, body: atualizarPoliticaBodySchema } },
    async (request, reply) => {
      const ator = { id: request.user!.sub, email: request.user!.email };
      const [politica] = await db
        .select()
        .from(politicas)
        .where(eq(politicas.id, request.params.id))
        .limit(1);
      if (!politica) return sendProblem(reply, 404, 'Política não encontrada', undefined);

      // Campos administrativos (descrição/ativa) sem `payload` não geram
      // versão nova nem tocam a AMAPI — só o payload é "a política" de
      // verdade pro `politicas_versoes` (seção 6).
      if (!request.body.payload) {
        const [atualizada] = await db
          .update(politicas)
          .set({ descricao: request.body.descricao, ativa: request.body.ativa })
          .where(eq(politicas.id, politica.id))
          .returning();
        await registrarAuditoria(db, {
          ator,
          acao: 'POLITICA_METADADOS_ALTERADOS',
          entidade: 'politica',
          entidadeId: politica.id,
          detalhes: request.body,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        return reply.send(atualizada);
      }

      if (!politica.amapiName) {
        // Não deveria acontecer (toda política nasce com `amapiName` via
        // `POST /policies`) — defesa contra dado legado/seed antigo sem o
        // envio real (o seed da Fase 3 roda só contra o nosso banco).
        return sendProblem(
          reply,
          422,
          'Política sem nome de recurso na AMAPI',
          'Esta política nunca foi enviada pra AMAPI — recrie-a via POST /policies.',
        );
      }

      const payloadCorrigido = await aplicarInvariantesEAuditar(
        request.body.payload,
        politica.id,
        ator,
        request.ip,
        request.headers['user-agent'],
      );

      const novaVersao = politica.versao + 1;
      const camposAdministrativos = {
        descricao: request.body.descricao ?? politica.descricao,
        ativa: request.body.ativa ?? politica.ativa,
      };
      const ip = request.ip;
      const userAgent = request.headers['user-agent'];

      try {
        const payloadFinal = await executarEscritaPoliticaSincrona(
          { nomePolitica: politica.amapiName, payload: payloadCorrigido },
          {
            aposTimeout: (resultado) => {
              if (resultado.status === 'sucesso') {
                void persistirPoliticaAtualizadaAposSucesso(
                  politica.id,
                  novaVersao,
                  resultado.payload,
                  camposAdministrativos,
                  ator,
                  ip,
                  userAgent,
                );
              } else {
                logger.error(
                  { err: resultado.erro, politicaId: politica.id },
                  'falha ao atualizar política na AMAPI (reconciliação tardia pós-timeout)',
                );
              }
            },
          },
        );
        const atualizada = await persistirPoliticaAtualizadaAposSucesso(
          politica.id,
          novaVersao,
          payloadFinal,
          camposAdministrativos,
          ator,
          ip,
          userAgent,
        );
        return reply.send(atualizada);
      } catch (erro) {
        if (erro instanceof EscritaPoliticaTimeoutError) {
          return respostaDeTimeout(reply, politica.id, erro);
        }
        logger.error(
          { err: erro, politicaId: politica.id },
          'falha ao atualizar política na AMAPI',
        );
        return sendProblem(reply, 502, 'Falha ao salvar política na AMAPI', String(erro));
      }
    },
  );

  // --- POST /policies/:id/rollback ---------------------------------------------
  // Cria uma versão NOVA com o payload de uma versão antiga — nunca reescreve
  // nem apaga histórico (mesmo princípio de `politicas_versoes` ser
  // append-only).
  zodApp.post(
    '/policies/:id/rollback',
    { ...withRole('ADMIN'), schema: { params: paramsIdSchema, body: rollbackBodySchema } },
    async (request, reply) => {
      const ator = { id: request.user!.sub, email: request.user!.email };
      const [politica] = await db
        .select()
        .from(politicas)
        .where(eq(politicas.id, request.params.id))
        .limit(1);
      if (!politica) return sendProblem(reply, 404, 'Política não encontrada', undefined);
      if (!politica.amapiName) {
        return sendProblem(reply, 422, 'Política sem nome de recurso na AMAPI', undefined);
      }

      const [versaoAlvo] = await db
        .select()
        .from(politicasVersoes)
        .where(
          and(
            eq(politicasVersoes.politicaId, politica.id),
            eq(politicasVersoes.versao, request.body.versao),
          ),
        )
        .limit(1);
      if (!versaoAlvo) return sendProblem(reply, 404, 'Versão não encontrada', undefined);

      // O payload restaurado passa por `enforceInvariants` de novo, igual
      // qualquer outro — nunca assume que uma versão antiga já gravada
      // ainda respeita os invariantes atuais (eles podem ter mudado desde
      // então).
      const payloadCorrigido = await aplicarInvariantesEAuditar(
        versaoAlvo.payload as PolicyPayload,
        politica.id,
        ator,
        request.ip,
        request.headers['user-agent'],
      );

      const novaVersao = politica.versao + 1;
      const versaoRestaurada = versaoAlvo.versao;
      const ip = request.ip;
      const userAgent = request.headers['user-agent'];

      try {
        const payloadFinal = await executarEscritaPoliticaSincrona(
          { nomePolitica: politica.amapiName, payload: payloadCorrigido },
          {
            aposTimeout: (resultado) => {
              if (resultado.status === 'sucesso') {
                void persistirRollbackAposSucesso(
                  politica.id,
                  novaVersao,
                  resultado.payload,
                  versaoRestaurada,
                  ator,
                  ip,
                  userAgent,
                );
              } else {
                logger.error(
                  { err: resultado.erro, politicaId: politica.id },
                  'falha ao aplicar rollback na AMAPI (reconciliação tardia pós-timeout)',
                );
              }
            },
          },
        );
        const atualizada = await persistirRollbackAposSucesso(
          politica.id,
          novaVersao,
          payloadFinal,
          versaoRestaurada,
          ator,
          ip,
          userAgent,
        );
        return reply.send(atualizada);
      } catch (erro) {
        if (erro instanceof EscritaPoliticaTimeoutError) {
          return respostaDeTimeout(reply, politica.id, erro);
        }
        logger.error({ err: erro, politicaId: politica.id }, 'falha ao aplicar rollback na AMAPI');
        return sendProblem(reply, 502, 'Falha ao salvar política na AMAPI', String(erro));
      }
    },
  );

  // --- DELETE /policies/:id ----------------------------------------------------
  // Soft: marca `ativa: false` — nunca apaga a linha (preservaria `politicas_
  // versoes` órfão, quebrando o histórico append-only). Só tenta remover o
  // recurso da AMAPI quando nenhum dispositivo ainda usa a política; a
  // própria AMAPI também recusaria (seção 7).
  zodApp.delete(
    '/policies/:id',
    { ...withRole('ADMIN'), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const ator = { id: request.user!.sub, email: request.user!.email };
      const [politica] = await db
        .select()
        .from(politicas)
        .where(eq(politicas.id, request.params.id))
        .limit(1);
      if (!politica) return sendProblem(reply, 404, 'Política não encontrada', undefined);

      const total = await db.$count(dispositivos, eq(dispositivos.politicaId, politica.id));
      if (total > 0) {
        return sendProblem(
          reply,
          409,
          'Política em uso',
          `${total} dispositivo(s) ainda usam esta política — reatribua-os antes de desativar.`,
        );
      }

      if (politica.amapiName) {
        try {
          await excluirPolitica(politica.amapiName);
        } catch (erro) {
          // Best-effort: o registro local desativa de qualquer forma; a
          // AMAPI pode já ter removido o recurso por fora, ou recusar por
          // um motivo que não bloqueia a desativação local.
          logger.warn(
            { err: erro, politicaId: politica.id },
            'falha ao remover política da AMAPI (best-effort)',
          );
        }
      }

      const [atualizada] = await db
        .update(politicas)
        .set({ ativa: false })
        .where(eq(politicas.id, politica.id))
        .returning();

      await registrarAuditoria(db, {
        ator,
        acao: 'POLITICA_DESATIVADA',
        entidade: 'politica',
        entidadeId: politica.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.send(atualizada);
    },
  );
}
