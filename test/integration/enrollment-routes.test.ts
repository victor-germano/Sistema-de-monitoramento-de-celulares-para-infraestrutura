// POST/GET/DELETE /enrollment/tokens (gap fechado nesta sessão — ver
// docs/HANDOFF-FRONTEND.md). Fronteira de rede com a AMAPI mockada no nível
// do client, mesmo padrão de `test/integration/comandos-devices.test.ts` —
// a cobertura do adapter em si já existe em `test/unit/amapi-enrollment.test.ts`.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as UsuariosSchemaModule from '../../src/db/schema/usuarios.ts';
import type * as PoliticasSchemaModule from '../../src/db/schema/politicas.ts';
import type * as ColaboradoresSchemaModule from '../../src/db/schema/colaboradores.ts';
import type * as EnrollmentSchemaModule from '../../src/db/schema/enrollment-tokens.ts';

const { clienteFake, obterClienteAmapiMock } = vi.hoisted(() => {
  const clienteFake = {
    enterprises: {
      enrollmentTokens: { create: vi.fn(), delete: vi.fn() },
    },
  };
  return { clienteFake, obterClienteAmapiMock: vi.fn().mockResolvedValue(clienteFake) };
});

vi.mock('../../src/integrations/amapi/client.ts', () => ({
  obterClienteAmapi: obterClienteAmapiMock,
  nomeEnterprise: () => 'enterprises/LC00000000000000000',
}));

type Role = 'VIEWER' | 'TECNICO' | 'ADMIN' | 'AUDITOR';
const tokensPorPapel = new Map<Role, string>();

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let app: FastifyInstance;
let db: typeof DbClientModule.db;
let usuarios: typeof UsuariosSchemaModule.usuarios;
let politicas: typeof PoliticasSchemaModule.politicas;
let colaboradores: typeof ColaboradoresSchemaModule.colaboradores;
let enrollmentTokens: typeof EnrollmentSchemaModule.enrollmentTokens;
let politicaId: string;
let colaboradorId: string;

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
  ({ politicas } = await import('../../src/db/schema/politicas.ts'));
  ({ colaboradores } = await import('../../src/db/schema/colaboradores.ts'));
  ({ enrollmentTokens } = await import('../../src/db/schema/enrollment-tokens.ts'));
  const { signSessionToken } = await import('../../src/domain/auth/session-tokens.ts');
  const { buildApp } = await import('../../src/app.ts');

  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  for (const role of ['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'] as const) {
    const [usuario] = await db
      .insert(usuarios)
      .values({
        oidcSubject: `oidc-enrollment-${role.toLowerCase()}`,
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

  const [politica] = await db
    .insert(politicas)
    .values({
      nome: 'politica-enrollment-teste',
      payload: { applications: [] },
      amapiName: 'enterprises/LC00000000000000000/policies/pol-enrollment-1',
    })
    .returning();
  if (!politica) throw new Error('falha ao semear política');
  politicaId = politica.id;

  const [colaborador] = await db
    .insert(colaboradores)
    .values({ matricula: 'MAT-ENROLLMENT-1', nome: 'Colaborador Enrollment' })
    .returning();
  if (!colaborador) throw new Error('falha ao semear colaborador');
  colaboradorId = colaborador.id;

  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
});

describe('POST /enrollment/tokens — RBAC', () => {
  it.each(['VIEWER', 'AUDITOR'] as const)('papel %s não pode criar — 403', async (role) => {
    const response = await app.inject({
      method: 'POST',
      url: '/enrollment/tokens',
      headers: authHeader(role),
      payload: { politicaId },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('POST /enrollment/tokens', () => {
  it('TECNICO cria com sucesso — devolve valor/qrCode em texto puro só desta vez', async () => {
    clienteFake.enterprises.enrollmentTokens.create.mockResolvedValueOnce({
      data: {
        name: 'enterprises/LC00000000000000000/enrollmentTokens/tok-1',
        value: 'valor-secreto-do-token-1',
        qrCode: '{"android.app.extra.PROVISIONING_WIFI_SSID":"..."}',
        expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/enrollment/tokens',
      headers: authHeader('TECNICO'),
      payload: { politicaId, patrimonio: 'PAT-NOVO-1', colaboradorId },
    });

    expect(response.statusCode).toBe(201);
    const corpo = response.json<{
      id: string;
      valor: string;
      qrCode: string;
      valorHash?: string;
    }>();
    expect(corpo.valor).toBe('valor-secreto-do-token-1');
    expect(corpo.qrCode).toContain('PROVISIONING_WIFI_SSID');
    // Nunca em texto puro em nenhum campo persistido — só o hash.
    expect(JSON.stringify(corpo)).not.toContain('valorHash":"valor-secreto');

    const [linha] = await db
      .select()
      .from(enrollmentTokens)
      .where(eq(enrollmentTokens.id, corpo.id))
      .limit(1);
    expect(linha?.valorHash).toBeDefined();
    expect(linha?.valorHash).not.toBe('valor-secreto-do-token-1');
    expect(linha?.patrimonio).toBe('PAT-NOVO-1');
  });

  it('política inexistente — 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/enrollment/tokens',
      headers: authHeader('TECNICO'),
      payload: { politicaId: '01a14117-0000-7000-8000-000000000000' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('colaborador inexistente — 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/enrollment/tokens',
      headers: authHeader('TECNICO'),
      payload: { politicaId, colaboradorId: '01a14117-0000-7000-8000-000000000001' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('falha na AMAPI — 502, nada persistido', async () => {
    clienteFake.enterprises.enrollmentTokens.create.mockRejectedValueOnce(
      new Error('AMAPI indisponível (simulado)'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/enrollment/tokens',
      headers: authHeader('TECNICO'),
      payload: { politicaId },
    });
    expect(response.statusCode).toBe(502);
  });
});

describe('GET /enrollment/tokens', () => {
  it('VIEWER pode listar', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/enrollment/tokens',
      headers: authHeader('VIEWER'),
    });
    expect(response.statusCode).toBe(200);
    const corpo = response.json<{ itens: unknown[] }>();
    expect(corpo.itens.length).toBeGreaterThan(0);
  });

  it('filtra por usado=false', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/enrollment/tokens?usado=false',
      headers: authHeader('VIEWER'),
    });
    expect(response.statusCode).toBe(200);
    const corpo = response.json<{ itens: { usadoEm: string | null }[] }>();
    expect(corpo.itens.every((item) => item.usadoEm === null)).toBe(true);
  });
});

describe('DELETE /enrollment/tokens/:id', () => {
  it('revoga um token não usado — 204, chama a AMAPI, remove do banco', async () => {
    clienteFake.enterprises.enrollmentTokens.create.mockResolvedValueOnce({
      data: {
        name: 'enterprises/LC00000000000000000/enrollmentTokens/tok-revogar',
        value: 'valor-pra-revogar',
        qrCode: '{}',
        expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const criado = await app.inject({
      method: 'POST',
      url: '/enrollment/tokens',
      headers: authHeader('TECNICO'),
      payload: { politicaId },
    });
    const { id } = criado.json<{ id: string }>();

    clienteFake.enterprises.enrollmentTokens.delete.mockResolvedValueOnce({});
    const resposta = await app.inject({
      method: 'DELETE',
      url: `/enrollment/tokens/${id}`,
      headers: authHeader('TECNICO'),
    });
    expect(resposta.statusCode).toBe(204);
    expect(clienteFake.enterprises.enrollmentTokens.delete).toHaveBeenCalledWith({
      name: 'enterprises/LC00000000000000000/enrollmentTokens/tok-revogar',
    });

    const [linha] = await db
      .select()
      .from(enrollmentTokens)
      .where(eq(enrollmentTokens.id, id))
      .limit(1);
    expect(linha).toBeUndefined();
  });

  it('token já usado — 409', async () => {
    clienteFake.enterprises.enrollmentTokens.create.mockResolvedValueOnce({
      data: {
        name: 'enterprises/LC00000000000000000/enrollmentTokens/tok-usado',
        value: 'valor-ja-usado',
        qrCode: '{}',
        expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const criado = await app.inject({
      method: 'POST',
      url: '/enrollment/tokens',
      headers: authHeader('TECNICO'),
      payload: { politicaId },
    });
    const { id } = criado.json<{ id: string }>();

    // Simula o que o handler do evento ENROLLMENT (Fase 4) faria de
    // verdade — marcar `usadoEm` ao reivindicar o token.
    await db
      .update(enrollmentTokens)
      .set({ usadoEm: new Date() })
      .where(eq(enrollmentTokens.id, id));

    const resposta = await app.inject({
      method: 'DELETE',
      url: `/enrollment/tokens/${id}`,
      headers: authHeader('TECNICO'),
    });
    expect(resposta.statusCode).toBe(409);
  });

  it('token inexistente — 404', async () => {
    const resposta = await app.inject({
      method: 'DELETE',
      url: '/enrollment/tokens/01a14117-0000-7000-8000-000000000002',
      headers: authHeader('TECNICO'),
    });
    expect(resposta.statusCode).toBe(404);
  });
});
