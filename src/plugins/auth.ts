import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { verifySessionToken, type SessionClaims } from '../domain/auth/session-tokens.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** `null` quando não há JWT válido no header — decidir se isso é um problema é responsabilidade da rota (`withRole`), não deste plugin. */
    user: SessionClaims | null;
  }
}

// `fastify-plugin` (fp) quebra o encapsulamento padrão do Fastify de
// propósito: sem isso, o decorator `request.user` e o hook abaixo só
// enxergariam rotas registradas DENTRO desta função — e as rotas de negócio
// são registradas como plugins irmãos em `app.ts`, não aninhadas aqui.
// eslint-disable-next-line @typescript-eslint/require-await -- `fastify-plugin` espera o formato `(instance, opts) => Promise<void>`; o `await` de verdade acontece dentro do hook `onRequest`, não no corpo desta função.
export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return;
    }

    try {
      request.user = await verifySessionToken(header.slice('Bearer '.length));
    } catch {
      // Token ausente, expirado ou malformado não é erro NESTE ponto — dar
      // 401 aqui de forma incondicional quebraria rotas públicas
      // (`/health`, `/auth/login`) que passam por este mesmo hook global.
      // `request.user` permanece `null` (default do decorator) e a rota
      // que exige autenticação (via `withRole`) é quem rejeita com 401/403.
    }
  });
});
