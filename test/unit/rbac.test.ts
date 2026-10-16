import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import rbacPlugin, { PUBLICA, withRole } from '../../src/plugins/rbac.ts';

// Unitário e isolado (Fastify puro, sem `buildApp()`/banco/Redis) — testa só
// o plugin em si, incluindo o branch de `onRoute` para rotas com múltiplos
// métodos HTTP (`method: string[]`), que nenhuma rota real do projeto usa
// hoje mas o Fastify permite — RBAC tem meta de 100% de cobertura (seção 14).
describe('rbacPlugin', () => {
  it('registra métodos múltiplos como string separada por vírgula no registry', async () => {
    const app = Fastify();
    await app.register(rbacPlugin);
    app.route({ method: ['GET', 'HEAD'], url: '/multi', ...PUBLICA, handler: () => 'ok' });
    await app.ready();

    const entrada = app.routeAccessRegistry.find((rota) => rota.url === '/multi');
    expect(entrada?.method).toBe('GET,HEAD');
  });

  it('rota sem `config.roles` nem `config.public` fica registrada sem declaração (o teste de integração é quem falha nesse caso)', async () => {
    const app = Fastify();
    await app.register(rbacPlugin);
    app.get('/sem-declaracao', () => 'ok');
    await app.ready();

    const entrada = app.routeAccessRegistry.find((rota) => rota.url === '/sem-declaracao');
    expect(entrada?.roles).toBeUndefined();
    expect(entrada?.public).toBeUndefined();
  });
});

// `authPlugin` decora `request.user`; sem ele, `request.user` seria
// `undefined`, não `null`, e `withRole` trataria os dois de forma diferente
// (undefined explode, null é o "não autenticado" esperado). Testado aqui
// registrando os dois plugins juntos, sem precisar da app inteira.
describe('withRole — sem authPlugin registrado (request.user nunca decorado)', () => {
  it('bloqueia mesmo sem request.user decorado — authPlugin é pré-requisito', async () => {
    const app = Fastify({ logger: false });
    await app.register(rbacPlugin);
    app.get('/protegida', withRole('ADMIN'), () => 'ok');
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/protegida' });
    // Sem `authPlugin`, `request.user` é `undefined` (não decorado) — o hook
    // ainda trata isso como "não autenticado" (checagem `!request.user`
    // cobre `undefined` e `null` igual) e responde 401, não estoura erro 500.
    expect(response.statusCode).toBe(401);
  });
});

// Achado numa revisão de segurança: `withRole` usava `preHandler`, que no
// Fastify roda DEPOIS da validação do schema do body — uma requisição
// anônima (ou com papel errado) e body inválido recebia 400, revelando os
// campos exatos da rota protegida antes de sequer checar autenticação.
// `withRole` agora usa `preValidation` (roda ANTES da validação) — este
// teste prova a ordem certa sem precisar da app inteira/Postgres/Redis.
describe('withRole — roda ANTES da validação do schema (não depois)', () => {
  // `papel` opcional: hook de `request.user` só é registrado quando um papel
  // é passado — precisa existir ANTES de `app.ready()` (Fastify não aceita
  // `addHook` depois de pronta), por isso não dá pra fatorar isso num
  // helper que já devolve a app "ready" e deixar quem chama decidir depois.
  async function appComRotaProtegida(papel?: 'ADMIN' | 'VIEWER') {
    const app = Fastify({ logger: false });
    app.decorateRequest('user', null);
    if (papel) {
      app.addHook('onRequest', (request, _reply, done) => {
        request.user = {
          sub: 'x',
          email: `${papel.toLowerCase()}@gruporoveri.com.br`,
          role: papel,
        };
        done();
      });
    }
    await app.register(rbacPlugin);
    app.post(
      '/protegida',
      {
        ...withRole('ADMIN'),
        schema: {
          body: { type: 'object', required: ['nome'], properties: { nome: { type: 'string' } } },
        },
      },
      () => 'ok',
    );
    await app.ready();
    return app;
  }

  it('sem token + body inválido: 401, nunca o 400 do schema', async () => {
    const app = await appComRotaProtegida();
    const response = await app.inject({ method: 'POST', url: '/protegida', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('papel errado + body inválido: 403, nunca o 400 do schema', async () => {
    const app = await appComRotaProtegida('VIEWER');
    const response = await app.inject({ method: 'POST', url: '/protegida', payload: {} });
    expect(response.statusCode).toBe(403);
  });

  it('papel certo + body inválido: 400 do schema (chega na validação normalmente)', async () => {
    const app = await appComRotaProtegida('ADMIN');
    const response = await app.inject({ method: 'POST', url: '/protegida', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});
