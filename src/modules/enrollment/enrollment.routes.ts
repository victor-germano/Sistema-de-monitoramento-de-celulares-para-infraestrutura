// POST/GET/DELETE /enrollment/tokens — seção 10, gap documentado desde a
// Fase 5 (docs/HANDOFF-FRONTEND.md, docs/SETUP.md): o adapter da AMAPI
// (`src/integrations/amapi/enrollment.ts`) e o processamento do evento
// `ENROLLMENT` (`src/domain/eventos/handlers/enrollment.ts`, Fase 4) já
// existiam prontos e testados — só faltava a rota HTTP que fecha o ciclo
// "técnico gera o QR code" → "device escaneia e aparece provisionado".
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../../db/client.ts';
import { politicas } from '../../db/schema/politicas.ts';
import {
  buscarEnrollmentTokenPorId,
  criarEnrollmentTokenLocal,
  excluirEnrollmentTokenLocal,
  listarEnrollmentTokens,
} from '../../domain/enrollment/repositorio.ts';
import { buscarColaboradorPorId } from '../../domain/colaboradores/repositorio.ts';
import { registrarAuditoria } from '../../domain/auditoria/registrar.ts';
import {
  criarEnrollmentToken,
  revogarEnrollmentToken,
} from '../../integrations/amapi/enrollment.ts';
import { sendProblem } from '../../shared/problem-details.ts';
import { zQueryBoolean } from '../../shared/zod-query.ts';
import { logger } from '../../shared/logger.ts';
import { withRole } from '../../plugins/rbac.ts';

const paramsIdSchema = z.object({ id: z.string().uuid() });

const criarBodySchema = z.object({
  politicaId: z.string().uuid(),
  patrimonio: z.string().min(1).optional(),
  colaboradorId: z.string().uuid().optional(),
});

const listarQuerySchema = z.object({
  usado: zQueryBoolean.optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// Mesma lógica de `hashToken` em `domain/auth/refresh-tokens.ts`: sha256
// basta porque o valor é um segredo de alta entropia gerado pelo Google
// (não uma senha de usuário sujeita a dicionário), não um caso pra
// bcrypt/scrypt. Não importado de lá de propósito — acoplar dois domínios
// sem relação (sessão de usuário vs. token de device) só pra reusar uma
// linha não compensa.
function hashValorToken(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}

const ROLES_LEITURA = ['VIEWER', 'TECNICO', 'ADMIN'] as const;
const ROLES_ESCRITA = ['TECNICO', 'ADMIN'] as const;

export function registerEnrollmentRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  // --- GET /enrollment/tokens --------------------------------------------
  zodApp.get(
    '/enrollment/tokens',
    { ...withRole(...ROLES_LEITURA), schema: { querystring: listarQuerySchema } },
    async (request) => {
      return listarEnrollmentTokens(request.query);
    },
  );

  // --- POST /enrollment/tokens --------------------------------------------
  // Devolve `valor`/`qrCode` em texto puro — a ÚNICA vez que isso acontece,
  // igual ao refresh token (seção 7): só o hash fica persistido, então uma
  // consulta posterior (`GET`) nunca mais consegue recuperar o conteúdo pra
  // gerar o QR de novo — se perder, o técnico precisa revogar e criar outro.
  zodApp.post(
    '/enrollment/tokens',
    { ...withRole(...ROLES_ESCRITA), schema: { body: criarBodySchema } },
    async (request, reply) => {
      const [politica] = await db
        .select()
        .from(politicas)
        .where(eq(politicas.id, request.body.politicaId))
        .limit(1);
      if (!politica) {
        return sendProblem(reply, 404, 'Política não encontrada', undefined);
      }
      // Não deveria acontecer (toda política nasce com `amapiName` —
      // POST /policies sempre define um antes de retornar, ver
      // politicas.routes.ts), mas o campo é nullable no schema — checar
      // explicitamente em vez de assumir evita um 500 opaco se isso mudar.
      if (!politica.amapiName) {
        return sendProblem(
          reply,
          422,
          'Política sem nome AMAPI',
          'Esta política ainda não foi sincronizada com a AMAPI — não é possível gerar um enrollment contra ela.',
        );
      }

      if (request.body.colaboradorId) {
        const colaborador = await buscarColaboradorPorId(request.body.colaboradorId);
        if (!colaborador) {
          return sendProblem(reply, 404, 'Colaborador não encontrado', undefined);
        }
      }

      // Gerado ANTES da chamada à AMAPI (não pelo insert): o handler do
      // evento `ENROLLMENT` (Fase 4) correlaciona pelo `tokenId` dentro do
      // `additionalData` que a própria AMAPI ecoa de volta no device — sem
      // conhecer o id com antecedência não dá pra montar esse payload
      // (mesmo motivo do `uuidPk` ser gerado na aplicação, ver ADR-001).
      const tokenId = crypto.randomUUID();

      let criado;
      try {
        criado = await criarEnrollmentToken({
          nomePolitica: politica.amapiName,
          additionalData: {
            tokenId,
            patrimonio: request.body.patrimonio,
            colaboradorId: request.body.colaboradorId,
          },
        });
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        logger.error(
          { erroMensagem: mensagem, politicaId: politica.id },
          'falha ao criar enrollment token na AMAPI',
        );
        return sendProblem(reply, 502, 'Falha ao criar enrollment token na AMAPI', mensagem);
      }

      if (!criado.valor) {
        // Resposta da AMAPI sem o campo que a própria integração promete
        // (`EnrollmentTokenCriado.valor`) — mais seguro falhar explícito
        // aqui do que devolver um token sem `valorHash` nenhum pra persistir.
        logger.error({ politicaId: politica.id }, 'AMAPI não retornou o valor do enrollment token');
        return sendProblem(
          reply,
          502,
          'Resposta inválida da AMAPI',
          'A AMAPI não retornou o valor do token — nada foi persistido, tente novamente.',
        );
      }

      // Risco aceito e documentado (mesma classe de problema de "política
      // fantasma" que `docs/ARQUITETURA.md` já descreve pra escrita de
      // política): se a AMAPI criar o token mas este insert falhar depois,
      // sobra um token "órfão" do nosso lado — órfão do lado da AMAPI, não
      // do nosso banco (não existe linha, então não aparece em lugar
      // nenhum da UI). Nenhum device consegue usá-lo porque o handler do
      // ENROLLMENT exige a linha existir (`enrollment.ts`, Fase 4) — o pior
      // caso é um token inofensivo expirando sozinho em 1h na AMAPI.
      const ator = { id: request.user!.sub, email: request.user!.email };
      const token = await criarEnrollmentTokenLocal({
        id: tokenId,
        amapiTokenName: criado.nomeRecurso,
        valorHash: hashValorToken(criado.valor),
        politicaId: politica.id,
        patrimonio: request.body.patrimonio,
        colaboradorId: request.body.colaboradorId,
        expiraEm: criado.expiraEm ?? new Date(Date.now() + 60 * 60 * 1000),
        criadoPor: ator.id,
      });

      await registrarAuditoria(db, {
        ator,
        acao: 'ENROLLMENT_TOKEN_CRIADO',
        entidade: 'enrollment_token',
        entidadeId: token.id,
        detalhes: { politicaId: politica.id, patrimonio: request.body.patrimonio },
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.status(201).send({
        ...token,
        valor: criado.valor,
        qrCode: criado.qrCode,
      });
    },
  );

  // --- DELETE /enrollment/tokens/:id --------------------------------------
  zodApp.delete(
    '/enrollment/tokens/:id',
    { ...withRole(...ROLES_ESCRITA), schema: { params: paramsIdSchema } },
    async (request, reply) => {
      const token = await buscarEnrollmentTokenPorId(request.params.id);
      if (!token) {
        return sendProblem(reply, 404, 'Enrollment token não encontrado', undefined);
      }
      if (token.usadoEm) {
        return sendProblem(
          reply,
          409,
          'Token já utilizado',
          'Este token já foi usado para provisionar um dispositivo — não pode mais ser revogado.',
        );
      }

      if (token.amapiTokenName) {
        try {
          await revogarEnrollmentToken(token.amapiTokenName);
        } catch (erro) {
          // Best-effort, mesmo padrão de `excluirPolitica` em
          // politicas.routes.ts: um token de 1h que já pode ter expirado
          // sozinho não deveria impedir a limpeza do nosso lado.
          const mensagem = erro instanceof Error ? erro.message : String(erro);
          logger.warn(
            { erroMensagem: mensagem, tokenId: token.id },
            'falha ao revogar enrollment token na AMAPI (best-effort)',
          );
        }
      }

      await excluirEnrollmentTokenLocal(token.id);

      const ator = { id: request.user!.sub, email: request.user!.email };
      await registrarAuditoria(db, {
        ator,
        acao: 'ENROLLMENT_TOKEN_REVOGADO',
        entidade: 'enrollment_token',
        entidadeId: token.id,
        detalhes: {},
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.status(204).send();
    },
  );
}
