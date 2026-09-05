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

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
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
