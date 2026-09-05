import fp from 'fastify-plugin';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import type { Role } from '../db/schema/usuarios.ts';
import { sendProblem } from '../shared/problem-details.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Papéis autorizados a chamar esta rota. Ausente + `public` ausente = erro de configuração, pego pelo teste "toda rota declara acesso". */
    roles?: readonly Role[];
    /** Marca explicitamente uma rota como pública (sem autenticação) — `/health`, `/auth/login`, `/auth/callback`. */
    public?: boolean;
  }
  interface FastifyInstance {
    /** Alimentado pelo hook `onRoute` abaixo; usado pelo teste que garante que nenhuma rota fica sem declarar papel/público. */
    routeAccessRegistry: RouteAccessInfo[];
  }
}

export interface RouteAccessInfo {
  method: string;
  url: string;
  roles?: readonly Role[];
  public?: boolean;
}

function requireRole(roles: readonly Role[]): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      sendProblem(
        reply,
        401,
        'Não autenticado',
        'Envie um token de sessão válido no header Authorization.',
      );
      return;
    }
    if (!roles.includes(request.user.role)) {
      sendProblem(
        reply,
        403,
        'Acesso negado',
        `O papel "${request.user.role}" não tem permissão para esta ação.`,
      );
    }
  };
}

/**
 * Uso: `app.get('/rota', { ...withRole('ADMIN', 'TECNICO') }, handler)`.
 * Empacota `preHandler` (o que de fato bloqueia) e `config.roles` (metadado
 * que o teste "toda rota declara papel" verifica) numa chamada só — não dá
 * pra esquecer de um sem o outro, porque são a mesma chamada.
 */
export function withRole(...roles: readonly Role[]): {
  config: { roles: readonly Role[] };
  preHandler: preHandlerAsyncHookHandler;
} {
  return { config: { roles }, preHandler: requireRole(roles) };
}

/** Uso: `app.get('/rota', PUBLICA, handler)` — rota sem autenticação, declarada de propósito. */
export const PUBLICA = { config: { public: true } } as const;

// eslint-disable-next-line @typescript-eslint/require-await -- `fastify-plugin` espera o formato `(instance, opts) => Promise<void>`; este plugin não precisa de `await` no corpo, só do formato.
export default fp(async function rbacPlugin(app: FastifyInstance) {
  app.decorate('routeAccessRegistry', [] as RouteAccessInfo[]);

  // Precisa ser registrado ANTES de qualquer rota (`onRoute` só dispara pra
  // rotas registradas DEPOIS que o hook existe) — por isso este plugin é o
  // primeiro a ser registrado em `app.ts`.
  app.addHook('onRoute', (routeOptions) => {
    const method = Array.isArray(routeOptions.method)
      ? routeOptions.method.join(',')
      : routeOptions.method;
    app.routeAccessRegistry.push({
      method,
      url: routeOptions.url,
      roles: routeOptions.config?.roles,
      public: routeOptions.config?.public,
    });
  });
});
