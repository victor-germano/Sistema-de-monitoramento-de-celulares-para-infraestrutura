// Rotas HTTP de `/alertas`, `/dashboard` e os dois novos `/internal/*`
// (Fase 6). RBAC é o foco aqui — o comportamento do motor em si já está
// coberto em `test/integration/motor-alertas.test.ts`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as UsuariosSchemaModule from '../../src/db/schema/usuarios.ts';
import type * as MotorModule from '../../src/domain/alertas/motor.ts';
import type * as DispositivosRepoModule from '../../src/domain/dispositivos/repositorio.ts';

type Role = 'VIEWER' | 'TECNICO' | 'ADMIN' | 'AUDITOR';
const TODOS_OS_PAPEIS: readonly Role[] = ['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'];
const tokensPorPapel = new Map<Role, string>();

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let app: FastifyInstance;
let db: typeof DbClientModule.db;
let usuarios: typeof UsuariosSchemaModule.usuarios;
let criarDispositivo: typeof DispositivosRepoModule.criarDispositivo;
let verificarAlertasReativos: typeof MotorModule.verificarAlertasReativos;
let alertaId: string;

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
  ({ criarDispositivo } = await import('../../src/domain/dispositivos/repositorio.ts'));
  ({ verificarAlertasReativos } = await import('../../src/domain/alertas/motor.ts'));

  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  for (const role of TODOS_OS_PAPEIS) {
    const [usuario] = await db
      .insert(usuarios)
      .values({
        oidcSubject: `oidc-alertas-${role.toLowerCase()}`,
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

  const dispositivo = await criarDispositivo(db, {
    amapiName: 'enterprises/x/devices/dev-alertas',
    ativo: true,
    complianceState: 'NON_COMPLIANT',
  });
  await verificarAlertasReativos(db, dispositivo);
  const { alertas } = await import('../../src/db/schema/alertas.ts');
  const { eq } = await import('drizzle-orm');
  const [alerta] = await db.select().from(alertas).where(eq(alertas.dispositivoId, dispositivo.id));
  if (!alerta) throw new Error('setup falhou — alerta não foi aberto');
  alertaId = alerta.id;

  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
});

describe('GET /alertas', () => {
  it('rejeita sem token', async () => {
    const response = await app.inject({ method: 'GET', url: '/alertas' });
    expect(response.statusCode).toBe(401);
  });

  it.each(TODOS_OS_PAPEIS)('aceita o papel %s, incluindo AUDITOR (ADR-028)', async (role) => {
    const response = await app.inject({
      method: 'GET',
      url: '/alertas',
      headers: authHeader(role),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ itens: unknown[] }>().itens.length).toBeGreaterThan(0);
  });

  it('filtra por tipo e por aberto=true', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/alertas?tipo=NAO_CONFORME&aberto=true',
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(200);
    const corpo = response.json<{ itens: { tipo: string; resolvidoEm: string | null }[] }>();
    expect(corpo.itens.every((a) => a.tipo === 'NAO_CONFORME' && a.resolvidoEm === null)).toBe(
      true,
    );
  });
});

describe('POST /alertas/:id/reconhecer e /resolver', () => {
  it.each(['VIEWER', 'AUDITOR'] as const)('papel %s não pode reconhecer — 403', async (role) => {
    const response = await app.inject({
      method: 'POST',
      url: `/alertas/${alertaId}/reconhecer`,
      headers: authHeader(role),
    });
    expect(response.statusCode).toBe(403);
  });

  it('TECNICO reconhece o alerta', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/alertas/${alertaId}/reconhecer`,
      headers: authHeader('TECNICO'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ reconhecidoEm: string }>().reconhecidoEm).toBeTruthy();
  });

  it('ADMIN resolve manualmente o alerta', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/alertas/${alertaId}/resolver`,
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ resolvidoEm: string }>().resolvidoEm).toBeTruthy();
  });

  it('404 pra alerta inexistente', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/alertas/00000000-0000-7000-8000-000000000000/resolver',
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /dashboard', () => {
  it.each(TODOS_OS_PAPEIS)('aceita o papel %s, incluindo AUDITOR', async (role) => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: authHeader(role),
    });
    expect(response.statusCode).toBe(200);
    const corpo = response.json<{
      dispositivos: { total: number };
      alertasAbertos: { total: number };
    }>();
    expect(corpo.dispositivos.total).toBeGreaterThan(0);
    expect(typeof corpo.alertasAbertos.total).toBe('number');
  });
});

describe('POST /internal/alertas/verificar', () => {
  it('só ADMIN pode chamar', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/alertas/verificar',
      headers: authHeader('TECNICO'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('ADMIN dispara o scan e recebe o resumo dos 3 tipos periódicos', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/alertas/verificar',
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(200);
    const corpo = response.json<Record<string, { candidatos: number }>>();
    expect(corpo).toHaveProperty('semCheckin');
    expect(corpo).toHaveProperty('dispositivosOrfaos');
    expect(corpo).toHaveProperty('linhasSemUso');
  });
});

describe('POST /internal/lgpd/purgar', () => {
  it('só ADMIN pode chamar', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/lgpd/purgar',
      headers: authHeader('VIEWER'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('ADMIN dispara a purga e recebe a contagem', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/lgpd/purgar',
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json<{ eventosBrutosPurgados: number }>().eventosBrutosPurgados).toBe(
      'number',
    );
  });
});
