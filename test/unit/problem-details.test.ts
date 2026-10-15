// Achado numa revisão: rotas que checam duplicidade antes de escrever
// (matrícula, número de linha, patrimônio) têm uma janela de corrida real
// entre o check e o INSERT/UPDATE. errorHandler agora trata qualquer
// violação de unicidade do Postgres (SQLSTATE 23505) como 409 — defesa de
// última linha, sistêmica, sem precisar que cada rota trate individualmente.
// Testado isolado (Fastify puro, sem banco/Redis) — o que importa é o
// comportamento do handler dado um erro com o `code` certo, não uma
// violação de índice único de verdade.
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { errorHandler, sendProblem } from '../../src/shared/problem-details.ts';

function appComErro(erro: unknown) {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  app.get('/explode', () => {
    throw erro;
  });
  return app;
}

describe('errorHandler — violação de unicidade do Postgres', () => {
  it('erro com code 23505 vira 409, nunca 500', async () => {
    const app = appComErro(Object.assign(new Error('duplicate key value'), { code: '23505' }));
    const response = await app.inject({ method: 'GET', url: '/explode' });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ title: string }>().title).toBe('Registro duplicado');
  });

  it('erro com outro code do Postgres (ex. not_null_violation) NÃO vira 409', async () => {
    const app = appComErro(Object.assign(new Error('null value'), { code: '23502' }));
    const response = await app.inject({ method: 'GET', url: '/explode' });
    expect(response.statusCode).not.toBe(409);
  });

  it('erro sem propriedade code (um Error comum) continua caindo no caminho genérico (500)', async () => {
    const app = appComErro(new Error('algo quebrou'));
    const response = await app.inject({ method: 'GET', url: '/explode' });
    expect(response.statusCode).toBe(500);
  });

  it('string lançada como erro (não é objeto) não quebra o handler', async () => {
    const app = appComErro('erro-em-string');
    const response = await app.inject({ method: 'GET', url: '/explode' });
    expect(response.statusCode).toBe(500);
  });
});

describe('sendProblem', () => {
  it('omite `detail` quando não informado, em vez de enviar undefined', async () => {
    const app = Fastify({ logger: false });
    app.get('/sem-detail', (_request, reply) => sendProblem(reply, 404, 'Não encontrado'));
    const response = await app.inject({ method: 'GET', url: '/sem-detail' });
    expect(response.json<{ detail?: string }>()).not.toHaveProperty('detail');
  });
});
