// Helper mínimo de RFC 9457 (Problem Details for HTTP APIs), exigido pela
// seção 10 da spec para todo erro da API. Nesta fase só existe a rota
// `/health` (sem corpo/query validados), então o handler cobre o caso
// genérico — erro de validação do Fastify e erro interno. O formato
// campo-a-campo dos erros de validação do Zod (útil pro front apontar o
// input errado) é refinado na Fase 2, quando existirem rotas de verdade
// validadas por schema pra testar contra o shape real do
// `fastify-type-provider-zod` em vez de adivinhar.
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

const PROBLEM_BASE_URI = 'https://docs.internal.gruporoveri.com.br/mdm/erros';

export function sendProblem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  const body: ProblemDetails = {
    type: `${PROBLEM_BASE_URI}/${status}`,
    title,
    status,
    ...(detail !== undefined && { detail }),
  };
  return reply.status(status).type('application/problem+json').send(body);
}

// SQLSTATE 23505 = unique_violation — código padrão do Postgres, devolvido
// pelo driver `postgres` (não um status HTTP nosso). Checagem estrutural
// (não `instanceof`) porque o tipo exato da classe de erro do driver não é
// exportado como algo que faça sentido importar aqui.
//
// Achado no upgrade do drizzle-orm (0.38 → 0.45, corrige GHSA-gpj5-g38j-94v9
// — SQL injection via identificador mal escapado): a partir da 0.44, todo
// erro de driver vem embrulhado num `DrizzleQueryError`, e o `PostgresError`
// original (com o `.code`) passa a viver em `.cause`, não mais direto no
// erro — confirmado empiricamente contra o Postgres real antes de aplicar
// este fix, não só pelo changelog. Olha os dois níveis (o erro em si e
// `.cause`) pra funcionar nos dois formatos, sem presumir qual versão do
// driver está rodando.
function codigoPostgres(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error && error.cause) return codigoPostgres(error.cause);
  return undefined;
}

function ehViolacaoDeUnicidade(error: unknown): boolean {
  return codigoPostgres(error) === '23505';
}

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Achado numa revisão: algumas rotas checam duplicidade (matrícula,
  // número de linha, patrimônio) ANTES de inserir/atualizar — mas entre
  // esse check e a escrita existe uma janela de corrida real (duas
  // requisições concorrentes podem as duas passar o check). Essa é a
  // defesa de ÚLTIMA linha, sistêmica: qualquer violação de unicidade do
  // Postgres que escape de um check prévio vira 409 aqui, pra TODA rota,
  // sem precisar que cada uma trate isso individualmente — nunca um 500
  // genérico pra um conflito de dado duplicado.
  if (ehViolacaoDeUnicidade(error)) {
    request.log.warn({ err: error }, 'violação de unicidade (23505) tratada como 409');
    sendProblem(reply, 409, 'Registro duplicado', 'Já existe um registro com esse valor único.');
    return;
  }

  const status = error.statusCode ?? 500;
  if (status >= 500) {
    request.log.error({ err: error }, 'erro não tratado');
  }

  sendProblem(
    reply,
    status,
    status >= 500 ? 'Erro interno' : error.name,
    status >= 500 ? 'Ocorreu um erro inesperado. Tente novamente.' : error.message,
  );
}
