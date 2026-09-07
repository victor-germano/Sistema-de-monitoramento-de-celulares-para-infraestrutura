// CRUD de colaboradores e linhas (Fase 5) — dado organizacional, sem
// nenhuma chamada à AMAPI (por isso, ao contrário de comandos/políticas,
// não precisa mockar client nenhum). `AUDITOR` fica de fora dos dois, mesma
// filosofia do ADR-004.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as UsuariosSchemaModule from '../../src/db/schema/usuarios.ts';

type Role = 'VIEWER' | 'TECNICO' | 'ADMIN' | 'AUDITOR';
const tokensPorPapel = new Map<Role, string>();

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let app: FastifyInstance;
let db: typeof DbClientModule.db;
let usuarios: typeof UsuariosSchemaModule.usuarios;

function authHeader(role: Role): { authorization: string } {
  const token = tokensPorPapel.get(role);
  if (!token) throw new Error(`nenhum token seedado para o papel ${role}`);
  return { authorization: `Bearer ${token}` };
}

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

  for (const role of ['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'] as const) {
    const [usuario] = await db
      .insert(usuarios)
      .values({
        oidcSubject: `oidc-org-${role.toLowerCase()}`,
        email: `${role.toLowerCase()}@gruporoveri.com.br`,
        nome: `Usuário (${role})`,
        role,
      })
      .returning();
    if (!usuario) throw new Error(`falha ao semear usuário ${role}`);
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

describe('/colaboradores', () => {
  it('AUDITOR não acessa — 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/colaboradores',
      headers: authHeader('AUDITOR'),
    });
    expect(response.statusCode).toBe(403);
  });

  it.each(['VIEWER', 'AUDITOR'] as const)('papel %s não pode criar — 403', async (role) => {
    const response = await app.inject({
      method: 'POST',
      url: '/colaboradores',
      headers: authHeader(role),
      payload: { matricula: 'x', nome: 'x' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('TECNICO cria, lista e edita um colaborador', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/colaboradores',
      headers: authHeader('TECNICO'),
      payload: { matricula: 'MAT-001', nome: 'Fulano de Tal', filial: 'SP', departamento: 'TI' },
    });
    expect(criado.statusCode).toBe(201);
    const { id } = criado.json<{ id: string }>();

    const listado = await app.inject({
      method: 'GET',
      url: '/colaboradores?filial=SP',
      headers: authHeader('VIEWER'),
    });
    expect(listado.statusCode).toBe(200);
    expect(listado.json<{ itens: { id: string }[] }>().itens.some((c) => c.id === id)).toBe(true);

    const editado = await app.inject({
      method: 'PATCH',
      url: `/colaboradores/${id}`,
      headers: authHeader('TECNICO'),
      payload: { departamento: 'Financeiro', ativo: false },
    });
    expect(editado.statusCode).toBe(200);
    const corpo = editado.json<{ departamento: string; ativo: boolean }>();
    expect(corpo.departamento).toBe('Financeiro');
    expect(corpo.ativo).toBe(false);
  });

  it('recusa matrícula duplicada com 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/colaboradores',
      headers: authHeader('ADMIN'),
      payload: { matricula: 'MAT-DUP', nome: 'A' },
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/colaboradores',
      headers: authHeader('ADMIN'),
      payload: { matricula: 'MAT-DUP', nome: 'B' },
    });
    expect(segunda.statusCode).toBe(409);
  });

  it('404 pra id inexistente', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/colaboradores/00000000-0000-7000-8000-000000000000',
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('/linhas', () => {
  it('AUDITOR não acessa — 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/linhas',
      headers: authHeader('AUDITOR'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('ADMIN cria, lista e edita status/valor de uma linha', async () => {
    const criada = await app.inject({
      method: 'POST',
      url: '/linhas',
      headers: authHeader('ADMIN'),
      payload: { numero: '+5511999990000', operadora: 'Vivo', valorMensal: 89.9, planoDadosGb: 20 },
    });
    expect(criada.statusCode).toBe(201);
    const { id } = criada.json<{ id: string; valorMensal: string }>();
    expect(criada.json<{ valorMensal: string }>().valorMensal).toBe('89.90');

    const listada = await app.inject({
      method: 'GET',
      url: '/linhas?operadora=Vivo',
      headers: authHeader('VIEWER'),
    });
    expect(listada.statusCode).toBe(200);
    expect(listada.json<{ itens: { id: string }[] }>().itens.some((l) => l.id === id)).toBe(true);

    const editada = await app.inject({
      method: 'PATCH',
      url: `/linhas/${id}`,
      headers: authHeader('ADMIN'),
      payload: { status: 'suspensa', valorMensal: 0 },
    });
    expect(editada.statusCode).toBe(200);
    const corpo = editada.json<{ status: string; valorMensal: string }>();
    expect(corpo.status).toBe('suspensa');
    expect(corpo.valorMensal).toBe('0.00');
  });

  it('recusa número duplicado com 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/linhas',
      headers: authHeader('ADMIN'),
      payload: { numero: '+5511988880000' },
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/linhas',
      headers: authHeader('ADMIN'),
      payload: { numero: '+5511988880000' },
    });
    expect(segunda.statusCode).toBe(409);
  });

  it('rejeita status fora do enum com 400', async () => {
    const criada = await app.inject({
      method: 'POST',
      url: '/linhas',
      headers: authHeader('ADMIN'),
      payload: { numero: '+5511977770000' },
    });
    const { id } = criada.json<{ id: string }>();

    const response = await app.inject({
      method: 'PATCH',
      url: `/linhas/${id}`,
      headers: authHeader('ADMIN'),
      payload: { status: 'nao-existe' },
    });
    expect(response.statusCode).toBe(400);
  });
});
