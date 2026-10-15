// Rotas de leitura/vínculo/comando de dispositivos — seção 10. Inventário
// (Fase 4) populado por ENROLLMENT/STATUS_REPORT; emissão de comando de
// verdade contra a AMAPI (Fase 5) via `POST /devices/:id/comandos`.
import { eq } from 'drizzle-orm';
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
import { env } from '../../config/env.ts';
import { db } from '../../db/client.ts';
import { comandos } from '../../db/schema/comandos.ts';
import { emitirComando, emitirWipe } from '../../integrations/amapi/commands.ts';
import { sendProblem } from '../../shared/problem-details.ts';
import { logger } from '../../shared/logger.ts';
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

// União discriminada por `tipo` — cada variante só aceita os campos que
// aquele comando de fato usa (seção 7): `novaSenha` só existe pra
// RESET_PASSWORD, `pacotes` só pra CLEAR_APP_DATA. WIPE exige dupla
// confirmação (patrimônio digitado + motivo ≥ 20 caracteres) — decisão já
// registrada no adapter (`src/integrations/amapi/commands.ts`) como
// responsabilidade desta rota.
const emitirComandoBodySchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('LOCK') }),
  z.object({ tipo: z.literal('REBOOT') }),
  z.object({ tipo: z.literal('RESET_PASSWORD'), novaSenha: z.string().min(6).optional() }),
  z.object({ tipo: z.literal('CLEAR_APP_DATA'), pacotes: z.array(z.string().min(1)).min(1) }),
  z.object({ tipo: z.literal('RELINQUISH_OWNERSHIP') }),
  z.object({
    tipo: z.literal('WIPE'),
    patrimonioConfirmacao: z.string().min(1),
    motivo: z.string().min(20, 'motivo precisa de pelo menos 20 caracteres'),
  }),
]);

// Gap da spec (nem a seção 5 nem a lista de permissões de
// `src/domain/auth/permissions.ts` cobrem `RELINQUISH_OWNERSHIP`): tratado
// como `ADMIN`-only, mesmo nível de `WIPE` — as duas são ações que tiram o
// device do controle da gestão de forma pouco reversível.
const TIPOS_SOMENTE_ADMIN = new Set<string>(['WIPE', 'RELINQUISH_OWNERSHIP']);

// Desligado em teste: a suíte de integração emite dezenas de comandos em
// segundos contra a mesma rota (não é tráfego real disparando LOCK/WIPE em
// loop, é a própria cobertura de teste) — sem isso, o rate limit real
// (10/min, seção 11) derrubaria os próprios testes com 429.
const RATE_LIMIT_COMANDOS =
  env.NODE_ENV === 'test' ? false : { max: 10, timeWindow: '1 minute' as const };

// Nunca persistir dado sensível no histórico (`comandos.payload`, visível
// via `GET /devices/:id/comandos` pra VIEWER/TECNICO/ADMIN) — `novaSenha`
// fica de fora de propósito, mesmo sendo o campo mais óbvio de "logar pra
// auditoria".
function payloadParaHistorico(
  body: z.infer<typeof emitirComandoBodySchema>,
): Record<string, unknown> | undefined {
  if (body.tipo === 'CLEAR_APP_DATA') return { pacotes: body.pacotes };
  if (body.tipo === 'WIPE') return { motivo: body.motivo };
  return undefined;
}

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

  // --- POST /devices/:id/comandos -----------------------------------------------
  // Emissão de verdade contra a AMAPI (Fase 5). Rate limit mais apertado que
  // o global (seção 11 pede limite específico nas rotas de comando) — evita
  // um script/bug disparando LOCK/WIPE em loop contra a frota inteira.
  zodApp.post(
    '/devices/:id/comandos',
    {
      ...withRole('TECNICO', 'ADMIN'),
      config: { ...withRole('TECNICO', 'ADMIN').config, rateLimit: RATE_LIMIT_COMANDOS },
      schema: { params: paramsIdSchema, body: emitirComandoBodySchema },
    },
    async (request, reply) => {
      if (TIPOS_SOMENTE_ADMIN.has(request.body.tipo) && request.user!.role !== 'ADMIN') {
        return sendProblem(
          reply,
          403,
          'Acesso negado',
          `O comando ${request.body.tipo} exige o papel ADMIN.`,
        );
      }

      const dispositivo = await buscarDispositivoPorId(request.params.id);
      if (!dispositivo) {
        return sendProblem(reply, 404, 'Dispositivo não encontrado', undefined);
      }

      if (
        request.body.tipo === 'WIPE' &&
        request.body.patrimonioConfirmacao !== dispositivo.patrimonio
      ) {
        return sendProblem(
          reply,
          422,
          'Confirmação inválida',
          'O patrimônio informado não confere com o do dispositivo — dupla confirmação obrigatória pra WIPE.',
        );
      }

      const ator = { id: request.user!.sub, email: request.user!.email };
      const [comando] = await db
        .insert(comandos)
        .values({
          dispositivoId: dispositivo.id,
          tipo: request.body.tipo,
          payload: payloadParaHistorico(request.body),
          status: 'PENDENTE',
          solicitadoPor: ator.id,
        })
        .returning();
      if (!comando) throw new Error('falha ao criar comando — insert não retornou linha');

      try {
        if (request.body.tipo === 'WIPE') {
          // `devices.delete` é síncrono do nosso ponto de vista — não existe
          // `Operation` assíncrona pra correlacionar depois via Pub/Sub
          // (diferente dos outros 5 tipos, `issueCommand`).
          await emitirWipe(dispositivo.amapiName, { wipeReasonMessage: request.body.motivo });
          await db
            .update(comandos)
            .set({ status: 'SUCESSO', concluidoEm: new Date() })
            .where(eq(comandos.id, comando.id));
        } else {
          const emitido = await emitirComando(dispositivo.amapiName, request.body.tipo, {
            novaSenha: request.body.tipo === 'RESET_PASSWORD' ? request.body.novaSenha : undefined,
            pacotes: request.body.tipo === 'CLEAR_APP_DATA' ? request.body.pacotes : undefined,
          });
          // `ENVIADO`, não `SUCESSO` — o resultado final só chega depois,
          // via evento `COMMAND` do Pub/Sub (`src/domain/eventos/handlers/
          // command.ts`, Fase 5), correlacionado por `amapiOperationName`.
          await db
            .update(comandos)
            .set({ status: 'ENVIADO', amapiOperationName: emitido.nomeOperacao })
            .where(eq(comandos.id, comando.id));
        }
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        await db
          .update(comandos)
          .set({ status: 'FALHA', erro: mensagem })
          .where(eq(comandos.id, comando.id));
        // NUNCA `{ err: erro }` aqui: pra RESET_PASSWORD, `erro` pode ser um
        // erro bruto do googleapis/gaxios carregando o body da requisição
        // original (com `newPassword`) em profundidade variável — o
        // serializer padrão do Pino copiaria isso pro log. Só a mensagem,
        // que nunca contém o payload da requisição, é segura de logar aqui
        // (achado numa revisão de segurança, ver PROJECT_MEMORY.md).
        logger.error(
          { erroMensagem: mensagem, comandoId: comando.id, tipo: request.body.tipo },
          'falha ao emitir comando na AMAPI',
        );
        return sendProblem(reply, 502, 'Falha ao emitir comando na AMAPI', mensagem);
      }

      await registrarAuditoria(db, {
        ator,
        acao: 'COMANDO_EMITIDO',
        entidade: 'dispositivo',
        entidadeId: dispositivo.id,
        detalhes: { comandoId: comando.id, tipo: request.body.tipo },
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      const [comandoFinal] = await db
        .select()
        .from(comandos)
        .where(eq(comandos.id, comando.id))
        .limit(1);
      return reply.status(201).send(comandoFinal);
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
