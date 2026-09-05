import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '../../src/modules/health/health.routes.js';

// `env.ts` faz o parse de `process.env` no momento do import (eager, ver
// comentário no próprio arquivo) — então as env vars dos containers têm que
// existir ANTES de qualquer módulo da aplicação ser importado. Um `import`
// estático no topo do arquivo é hoisted e rodaria antes do `beforeAll`, por
// isso o `buildApp` só é importado dinamicamente depois dos containers
// estarem de pé.
let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let app: FastifyInstance;

beforeAll(async () => {
  [postgresContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = postgresContainer.getConnectionUri();
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { buildApp } = await import('../../src/app.js');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
});

describe('GET /health', () => {
  it('responde 200 com database e redis "up" quando ambos estão disponíveis', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('up');
    expect(body.checks.redis.status).toBe('up');
    expect(typeof body.timestamp).toBe('string');
  });
});
