import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as UsuariosSchemaModule from '../../src/db/schema/usuarios.ts';

// Mesmo motivo do `health.test.ts`: `env.ts` faz parse eager de
// `process.env`, então tudo que depende dele (schema, app, session-tokens)
// só pode ser importado DEPOIS de `DATABASE_URL`/`REDIS_URL` apontarem pros
// containers — daí os imports dinâmicos dentro do `beforeAll`.
let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let app: FastifyInstance;
let db: typeof DbClientModule.db;
let usuarios: typeof UsuariosSchemaModule.usuarios;

type Role = 'VIEWER' | 'TECNICO' | 'ADMIN' | 'AUDITOR';
const TODOS_OS_PAPEIS: readonly Role[] = ['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'];
const tokensPorPapel = new Map<Role, string>();
const usuarioIdsPorPapel = new Map<Role, string>();

beforeAll(async () => {
  [postgresContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = postgresContainer.getConnectionUri();
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  ({ db } = await import('../../src/db/client.ts'));
  ({ usuarios } = await import('../../src/db/schema/usuarios.ts'));
  const { signSessionToken } = await import('../../src/domain/auth/session-tokens.ts');
  const { buildApp } = await import('../../src/app.ts');

  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  // Um usuário real por papel — os testes de RBAC assinam token pra um
  // usuário que EXISTE no banco (não um claim inventado), porque rotas como
  // `/auth/me` e `/usuarios` fazem lookup fresco no banco, não confiam só
  // no JWT.
  for (const role of TODOS_OS_PAPEIS) {
    const [usuario] = await db
      .insert(usuarios)
      .values({
        oidcSubject: `oidc-teste-${role.toLowerCase()}`,
        email: `${role.toLowerCase()}@gruporoveri.com.br`,
        nome: `Usuário de teste (${role})`,
        role,
      })
      .returning();
    if (!usuario) throw new Error(`falha ao semear usuário de teste com papel ${role}`);

    usuarioIdsPorPapel.set(role, usuario.id);
    tokensPorPapel.set(
      role,
      await signSessionToken({ sub: usuario.id, email: usuario.email, role: usuario.role }),
    );
  }

  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
});

function authHeader(role: Role): { authorization: string } {
  const token = tokensPorPapel.get(role);
  if (!token) throw new Error(`nenhum token seedado para o papel ${role}`);
  return { authorization: `Bearer ${token}` };
}

describe('RBAC — toda rota declara papel ou é pública', () => {
  it('nenhuma rota de negócio fica sem `roles` nem `public` no config', () => {
    // `/docs*` é registrada pelo @fastify/swagger-ui, plugin de terceiro —
    // não temos como (nem faz sentido) anotar `config.roles` nas rotas
    // internas dele. O contrato "toda rota declara acesso" vale pras rotas
    // que ESTE projeto define.
    const rotasDoProjeto = app.routeAccessRegistry.filter((rota) => !rota.url.startsWith('/docs'));

    expect(rotasDoProjeto.length).toBeGreaterThan(0);

    const semDeclaracao = rotasDoProjeto.filter(
      (rota) => !rota.public && (!rota.roles || rota.roles.length === 0),
    );

    expect(semDeclaracao).toEqual([]);
  });
});

describe('RBAC — GET /usuarios (ADMIN)', () => {
  it('rejeita sem token com 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/usuarios' });
    expect(response.statusCode).toBe(401);
  });

  it.each(['VIEWER', 'TECNICO', 'AUDITOR'] as const)('rejeita papel %s com 403', async (role) => {
    const response = await app.inject({
      method: 'GET',
      url: '/usuarios',
      headers: authHeader(role),
    });
    expect(response.statusCode).toBe(403);
  });

  it('aceita ADMIN com 200', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/usuarios',
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('RBAC — PATCH /usuarios/:id (ADMIN)', () => {
  it.each(['VIEWER', 'TECNICO', 'AUDITOR'] as const)('rejeita papel %s com 403', async (role) => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/usuarios/00000000-0000-7000-8000-000000000000',
      headers: authHeader(role),
      payload: { role: 'TECNICO' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('ADMIN passa da checagem de papel (404 é do id inexistente, não RBAC)', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/usuarios/00000000-0000-7000-8000-000000000000',
      headers: authHeader('ADMIN'),
      payload: { role: 'TECNICO' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('PATCH /usuarios/:id — proteção do último ADMIN (ADR-013)', () => {
  it('recusa com 422 rebaixar o único ADMIN ativo', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/usuarios/${usuarioIdsPorPapel.get('ADMIN')}`,
      headers: authHeader('ADMIN'),
      payload: { role: 'VIEWER' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('permite rebaixar um ADMIN quando existe outro ADMIN ativo', async () => {
    const [segundoAdmin] = await db
      .insert(usuarios)
      .values({
        oidcSubject: 'oidc-teste-admin-2',
        email: 'admin2@gruporoveri.com.br',
        nome: 'Segundo Admin de teste',
        role: 'ADMIN',
      })
      .returning();
    if (!segundoAdmin) throw new Error('falha ao semear o segundo ADMIN de teste');

    const response = await app.inject({
      method: 'PATCH',
      url: `/usuarios/${segundoAdmin.id}`,
      headers: authHeader('ADMIN'),
      payload: { role: 'VIEWER' },
    });
    expect(response.statusCode).toBe(200);

    // Devolve o sistema ao estado anterior (um único ADMIN ativo) pra não
    // interferir nos outros testes deste arquivo que rodam depois.
    await db.update(usuarios).set({ role: 'ADMIN' }).where(eq(usuarios.id, segundoAdmin.id));
  });
});

describe('RBAC — GET /auth/me (qualquer papel autenticado)', () => {
  it('rejeita sem token com 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it.each(TODOS_OS_PAPEIS)('aceita o papel %s com 200 e devolve a role certa', async (role) => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(role),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ role: Role }>().role).toBe(role);
  });
});
