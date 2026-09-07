// `POST /devices/:id/comandos` (Fase 5) + o handler `COMMAND` do Pub/Sub que
// fecha o ciclo assíncrono. A fronteira de rede com a AMAPI é mockada no
// nível do client (`src/integrations/amapi/client.ts`) — mesmo padrão de
// `test/unit/amapi-commands.test.ts` — porque aqui o interesse é a
// orquestração da rota (RBAC por tipo, dupla confirmação do WIPE, o que vai
// pro banco), não repetir a cobertura já feita no adapter.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as UsuariosSchemaModule from '../../src/db/schema/usuarios.ts';
import type * as DispositivosSchemaModule from '../../src/db/schema/dispositivos.ts';
import type * as ComandosSchemaModule from '../../src/db/schema/comandos.ts';
import type * as ProcessarEventoModule from '../../src/domain/eventos/processar-evento.ts';

const { clienteFake, obterClienteAmapiMock } = vi.hoisted(() => {
  const clienteFake = {
    enterprises: {
      devices: { issueCommand: vi.fn(), delete: vi.fn() },
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
let dispositivos: typeof DispositivosSchemaModule.dispositivos;
let comandos: typeof ComandosSchemaModule.comandos;
let processarEventoBruto: typeof ProcessarEventoModule.processarEventoBruto;
let dispositivoId: string;

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
  ({ dispositivos } = await import('../../src/db/schema/dispositivos.ts'));
  ({ comandos } = await import('../../src/db/schema/comandos.ts'));
  ({ processarEventoBruto } = await import('../../src/domain/eventos/processar-evento.ts'));
  const { signSessionToken } = await import('../../src/domain/auth/session-tokens.ts');
  const { buildApp } = await import('../../src/app.ts');

  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  for (const role of ['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'] as const) {
    const [usuario] = await db
      .insert(usuarios)
      .values({
        oidcSubject: `oidc-comandos-${role.toLowerCase()}`,
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

  const [dispositivo] = await db
    .insert(dispositivos)
    .values({
      amapiName: 'enterprises/LC00000000000000000/devices/dev-comando',
      patrimonio: 'PAT-COMANDO-1',
    })
    .returning();
  if (!dispositivo) throw new Error('falha ao semear dispositivo');
  dispositivoId = dispositivo.id;

  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
});

describe('POST /devices/:id/comandos — RBAC', () => {
  it.each(['VIEWER', 'AUDITOR'] as const)(
    'papel %s não pode emitir comando — 403',
    async (role) => {
      const response = await app.inject({
        method: 'POST',
        url: `/devices/${dispositivoId}/comandos`,
        headers: authHeader(role),
        payload: { tipo: 'LOCK' },
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it('TECNICO pode emitir LOCK', async () => {
    clienteFake.enterprises.devices.issueCommand.mockResolvedValueOnce({
      data: { name: 'operations/op-lock-1' },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('TECNICO'),
      payload: { tipo: 'LOCK' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ status: string; amapiOperationName: string }>().status).toBe('ENVIADO');
  });

  it.each(['WIPE', 'RELINQUISH_OWNERSHIP'] as const)(
    'TECNICO não pode emitir %s — exige ADMIN',
    async (tipo) => {
      const response = await app.inject({
        method: 'POST',
        url: `/devices/${dispositivoId}/comandos`,
        headers: authHeader('TECNICO'),
        payload:
          tipo === 'WIPE'
            ? {
                tipo,
                patrimonioConfirmacao: 'PAT-COMANDO-1',
                motivo: 'motivo com mais de vinte caracteres',
              }
            : { tipo },
      });
      expect(response.statusCode).toBe(403);
    },
  );
});

describe('POST /devices/:id/comandos — WIPE (dupla confirmação)', () => {
  it('422 quando o patrimônio de confirmação não confere', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('ADMIN'),
      payload: {
        tipo: 'WIPE',
        patrimonioConfirmacao: 'PATRIMONIO-ERRADO',
        motivo: 'motivo com mais de vinte caracteres',
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it('400 quando o motivo tem menos de 20 caracteres', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('ADMIN'),
      payload: { tipo: 'WIPE', patrimonioConfirmacao: 'PAT-COMANDO-1', motivo: 'curto' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('ADMIN com confirmação correta executa o wipe (síncrono, sem operation)', async () => {
    clienteFake.enterprises.devices.delete.mockResolvedValueOnce({ data: {} });
    const response = await app.inject({
      method: 'POST',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('ADMIN'),
      payload: {
        tipo: 'WIPE',
        patrimonioConfirmacao: 'PAT-COMANDO-1',
        motivo: 'motivo com mais de vinte caracteres',
      },
    });
    expect(response.statusCode).toBe(201);
    const corpo = response.json<{
      status: string;
      payload: { motivo?: string; patrimonioConfirmacao?: string };
    }>();
    expect(corpo.status).toBe('SUCESSO');
    // Confirmação (patrimônio) nunca persistida — só o motivo, pro histórico.
    expect(corpo.payload.patrimonioConfirmacao).toBeUndefined();
    expect(corpo.payload.motivo).toContain('vinte caracteres');
  });
});

describe('POST /devices/:id/comandos — RESET_PASSWORD nunca vaza a senha', () => {
  it('novaSenha não aparece no registro do comando', async () => {
    clienteFake.enterprises.devices.issueCommand.mockResolvedValueOnce({
      data: { name: 'operations/op-senha' },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('ADMIN'),
      payload: { tipo: 'RESET_PASSWORD', novaSenha: 'segredo-super-secreto' },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.stringify(response.json())).not.toContain('segredo-super-secreto');
  });
});

describe('POST /devices/:id/comandos — falha da AMAPI', () => {
  it('502 e status FALHA quando issueCommand rejeita', async () => {
    clienteFake.enterprises.devices.issueCommand.mockRejectedValueOnce(
      new Error('AMAPI fora do ar'),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('TECNICO'),
      payload: { tipo: 'REBOOT' },
    });
    expect(response.statusCode).toBe(502);
  });
});

describe('handler COMMAND — fecha o ciclo assíncrono via evento Pub/Sub', () => {
  it('marca SUCESSO quando a Operation vem done sem erro', async () => {
    clienteFake.enterprises.devices.issueCommand.mockResolvedValueOnce({
      data: { name: 'operations/op-sucesso' },
    });
    const emissao = await app.inject({
      method: 'POST',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('TECNICO'),
      payload: { tipo: 'LOCK' },
    });
    const { id: comandoId } = emissao.json<{ id: string }>();

    const { eventosBrutos } = await import('../../src/db/schema/eventos-brutos.ts');
    const [evento] = await db
      .insert(eventosBrutos)
      .values({
        messageId: `msg-command-${comandoId}`,
        notificationType: 'COMMAND',
        payload: { attributes: {}, data: { name: 'operations/op-sucesso', done: true } },
      })
      .returning();
    if (!evento) throw new Error('setup falhou');

    const resultado = await processarEventoBruto(evento.id);
    expect(resultado.status).toBe('processado');

    const [comandoAtualizado] = await db.select().from(comandos).where(eq(comandos.id, comandoId));
    expect(comandoAtualizado?.status).toBe('SUCESSO');
    expect(comandoAtualizado?.concluidoEm).toBeInstanceOf(Date);
  });

  it('marca FALHA quando a Operation vem done com error', async () => {
    clienteFake.enterprises.devices.issueCommand.mockResolvedValueOnce({
      data: { name: 'operations/op-falha' },
    });
    const emissao = await app.inject({
      method: 'POST',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('TECNICO'),
      payload: { tipo: 'REBOOT' },
    });
    const { id: comandoId } = emissao.json<{ id: string }>();

    const { eventosBrutos } = await import('../../src/db/schema/eventos-brutos.ts');
    const [evento] = await db
      .insert(eventosBrutos)
      .values({
        messageId: `msg-command-falha-${comandoId}`,
        notificationType: 'COMMAND',
        payload: {
          attributes: {},
          data: {
            name: 'operations/op-falha',
            done: true,
            error: { code: 7, message: 'device offline' },
          },
        },
      })
      .returning();
    if (!evento) throw new Error('setup falhou');

    await processarEventoBruto(evento.id);

    const [comandoAtualizado] = await db.select().from(comandos).where(eq(comandos.id, comandoId));
    expect(comandoAtualizado?.status).toBe('FALHA');
    expect(comandoAtualizado?.erro).toBe('device offline');
  });

  it('não faz nada quando a Operation ainda não terminou (done: false)', async () => {
    clienteFake.enterprises.devices.issueCommand.mockResolvedValueOnce({
      data: { name: 'operations/op-em-andamento' },
    });
    const emissao = await app.inject({
      method: 'POST',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('TECNICO'),
      payload: { tipo: 'LOCK' },
    });
    const { id: comandoId, status: statusOriginal } = emissao.json<{
      id: string;
      status: string;
    }>();

    const { eventosBrutos } = await import('../../src/db/schema/eventos-brutos.ts');
    const [evento] = await db
      .insert(eventosBrutos)
      .values({
        messageId: `msg-command-andamento-${comandoId}`,
        notificationType: 'COMMAND',
        payload: { attributes: {}, data: { name: 'operations/op-em-andamento', done: false } },
      })
      .returning();
    if (!evento) throw new Error('setup falhou');

    await processarEventoBruto(evento.id);

    const [comandoAtualizado] = await db.select().from(comandos).where(eq(comandos.id, comandoId));
    expect(comandoAtualizado?.status).toBe(statusOriginal); // continua ENVIADO
  });
});
