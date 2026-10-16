// CRUD de políticas (Fase 5) contra Postgres + Redis reais. A fronteira de
// rede com a AMAPI nunca é mockada via `vi.mock` aqui — em vez disso, o
// PROCESSADOR da fila (o que `criarWorkerEscritaPolitica` chama) é
// substituído por uma função de teste, mesmo padrão de
// `test/integration/policy-write-queue.test.ts` (Fase 3): a fila/worker de
// verdade rodam, só o que aconteceria dentro de `salvarPolitica` é
// simulado.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Worker } from 'bullmq';
import { auditoria } from '../../src/db/schema/auditoria.ts';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as UsuariosSchemaModule from '../../src/db/schema/usuarios.ts';
import type * as PoliticasSchemaModule from '../../src/db/schema/politicas.ts';
import type * as DispositivosSchemaModule from '../../src/db/schema/dispositivos.ts';
import type * as PolicyQueueModule from '../../src/queues/policy-write-queue.ts';

type Role = 'VIEWER' | 'TECNICO' | 'ADMIN' | 'AUDITOR';
const tokensPorPapel = new Map<Role, string>();

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let app: FastifyInstance;
let db: typeof DbClientModule.db;
let usuarios: typeof UsuariosSchemaModule.usuarios;
let politicas: typeof PoliticasSchemaModule.politicas;
let politicasVersoes: typeof PoliticasSchemaModule.politicasVersoes;
let dispositivos: typeof DispositivosSchemaModule.dispositivos;
let criarWorkerEscritaPolitica: typeof PolicyQueueModule.criarWorkerEscritaPolitica;
let fecharFilaEscritaPolitica: typeof PolicyQueueModule.fecharFilaEscritaPolitica;
let worker: Worker;

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
  ({ politicas, politicasVersoes } = await import('../../src/db/schema/politicas.ts'));
  ({ dispositivos } = await import('../../src/db/schema/dispositivos.ts'));
  ({ criarWorkerEscritaPolitica, fecharFilaEscritaPolitica } =
    await import('../../src/queues/policy-write-queue.ts'));
  const { signSessionToken } = await import('../../src/domain/auth/session-tokens.ts');
  const { buildApp } = await import('../../src/app.ts');

  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  for (const role of ['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'] as const) {
    const [usuario] = await db
      .insert(usuarios)
      .values({
        oidcSubject: `oidc-politicas-${role.toLowerCase()}`,
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

  // Processador de teste: simula `salvarPolitica` sem tocar rede — devolve
  // o payload como se a AMAPI tivesse aceitado, exceto quando o payload
  // carrega o sentinela `__forcarFalha` (simula uma rejeição 400 da AMAPI).
  worker = criarWorkerEscritaPolitica((dados) => {
    if ((dados.payload as { __forcarFalha?: boolean }).__forcarFalha) {
      throw new Error('AMAPI recusou o payload (simulado)');
    }
    return Promise.resolve(dados.payload);
  });

  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await worker?.close();
  await fecharFilaEscritaPolitica();
  await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
});

describe('POST /policies', () => {
  it.each(['VIEWER', 'TECNICO', 'AUDITOR'] as const)(
    'papel %s não pode criar — 403',
    async (role) => {
      const response = await app.inject({
        method: 'POST',
        url: '/policies',
        headers: authHeader(role),
        payload: { nome: 'x', payload: {} },
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it('ADMIN cria a política, envia pra "AMAPI" e grava a versão 1', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'teste-criacao', descricao: 'desc', payload: { applications: [] } },
    });
    expect(response.statusCode).toBe(201);
    const corpo = response.json<{ id: string; amapiName: string; versao: number }>();
    expect(corpo.amapiName).toContain(corpo.id);
    expect(corpo.versao).toBe(1);

    const versoes = await db
      .select()
      .from(politicasVersoes)
      .where(eq(politicasVersoes.politicaId, corpo.id));
    expect(versoes).toHaveLength(1);
    expect(versoes[0]?.versao).toBe(1);
  });

  it('recusa nome duplicado com 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'duplicada', payload: {} },
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'duplicada', payload: {} },
    });
    expect(segunda.statusCode).toBe(409);
  });

  it('aplica os invariantes e audita a correção quando o payload os viola', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'viola-invariante', payload: { uninstallAppsDisabled: false } },
    });
    expect(response.statusCode).toBe(201);
    const corpo = response.json<{ id: string; payload: { uninstallAppsDisabled: boolean } }>();
    expect(corpo.payload.uninstallAppsDisabled).toBe(true); // corrigido, não o `false` enviado

    const linhas = await db.select().from(auditoria).where(eq(auditoria.entidadeId, corpo.id));
    expect(linhas.some((l) => l.acao === 'POLITICA_INVARIANT_OVERRIDE')).toBe(true);
  });

  it('502 quando a AMAPI (simulada) recusa o payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'vai-falhar', payload: { __forcarFalha: true } },
    });
    expect(response.statusCode).toBe(502);

    const politica = await db.query.politicas.findFirst({
      where: (p, { eq }) => eq(p.nome, 'vai-falhar'),
    });
    expect(politica).toBeUndefined(); // nunca chegou a ser persistida localmente (falhou antes do UPDATE final)
  });
});

describe('PATCH /policies/:id', () => {
  async function criarPoliticaBase(nome: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome, payload: { applications: [] } },
    });
    return response.json<{ id: string; versao: number }>();
  }

  it('incrementa a versão e grava o histórico a cada edição de payload', async () => {
    const politica = await criarPoliticaBase('editar-versao');

    const response = await app.inject({
      method: 'PATCH',
      url: `/policies/${politica.id}`,
      headers: authHeader('ADMIN'),
      payload: {
        payload: { applications: [{ packageName: 'com.a', installType: 'FORCE_INSTALLED' }] },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ versao: number }>().versao).toBe(2);

    const versoes = await db
      .select()
      .from(politicasVersoes)
      .where(eq(politicasVersoes.politicaId, politica.id));
    expect(versoes.map((v) => v.versao).sort()).toEqual([1, 2]);
  });

  it('altera só metadados (sem payload) sem criar versão nova', async () => {
    const politica = await criarPoliticaBase('editar-metadados');

    const response = await app.inject({
      method: 'PATCH',
      url: `/policies/${politica.id}`,
      headers: authHeader('ADMIN'),
      payload: { descricao: 'nova descrição' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ versao: number }>().versao).toBe(1);
  });

  it('TECNICO não pode editar política — 403', async () => {
    const politica = await criarPoliticaBase('tecnico-nao-edita');
    const response = await app.inject({
      method: 'PATCH',
      url: `/policies/${politica.id}`,
      headers: authHeader('TECNICO'),
      payload: { descricao: 'x' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('POST /policies/:id/rollback', () => {
  it('restaura o payload de uma versão antiga como uma versão NOVA', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'rollback-teste', payload: { applications: [] } },
    });
    const { id } = criado.json<{ id: string }>();

    await app.inject({
      method: 'PATCH',
      url: `/policies/${id}`,
      headers: authHeader('ADMIN'),
      payload: {
        payload: { applications: [{ packageName: 'com.b', installType: 'FORCE_INSTALLED' }] },
      },
    });

    const rollback = await app.inject({
      method: 'POST',
      url: `/policies/${id}/rollback`,
      headers: authHeader('ADMIN'),
      payload: { versao: 1 },
    });
    expect(rollback.statusCode).toBe(200);
    const corpo = rollback.json<{ versao: number; payload: { applications: unknown[] } }>();
    expect(corpo.versao).toBe(3); // versão nova, não reescreve a 1
    expect(corpo.payload.applications).toEqual([]); // conteúdo da versão 1 restaurado
  });

  it('404 pra versão inexistente', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'rollback-inexistente', payload: {} },
    });
    const { id } = criado.json<{ id: string }>();

    const response = await app.inject({
      method: 'POST',
      url: `/policies/${id}/rollback`,
      headers: authHeader('ADMIN'),
      payload: { versao: 999 },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /policies/:id', () => {
  it('recusa com 409 quando algum dispositivo ainda usa a política', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'em-uso', payload: {} },
    });
    const { id } = criado.json<{ id: string }>();

    const [dispositivo] = await db
      .insert(dispositivos)
      .values({ amapiName: 'enterprises/x/devices/em-uso', politicaId: id })
      .returning();
    if (!dispositivo) throw new Error('setup falhou');

    const response = await app.inject({
      method: 'DELETE',
      url: `/policies/${id}`,
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(409);
  });

  it('desativa (soft) quando nenhum dispositivo usa a política', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'sem-uso', payload: {} },
    });
    const { id } = criado.json<{ id: string }>();

    const response = await app.inject({
      method: 'DELETE',
      url: `/policies/${id}`,
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ativa: boolean }>().ativa).toBe(false);

    // Preservada, não apagada — histórico (`politicas_versoes`) continua íntegro.
    const [ainda] = await db.select().from(politicas).where(eq(politicas.id, id));
    expect(ainda).toBeDefined();
  });
});

describe('GET /policies', () => {
  it.each(['VIEWER', 'TECNICO', 'ADMIN'] as const)('papel %s pode listar', async (role) => {
    const response = await app.inject({
      method: 'GET',
      url: '/policies',
      headers: authHeader(role),
    });
    expect(response.statusCode).toBe(200);
  });

  it('AUDITOR não acessa (mesma filosofia do ADR-004)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/policies',
      headers: authHeader('AUDITOR'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('filtra por ?ativa=false/true corretamente (achado numa revisão)', async () => {
    // z.coerce.boolean() fazia Boolean("false") === true — ?ativa=false
    // devolvia política ATIVA, o contrário do pedido.
    const criada = await app.inject({
      method: 'POST',
      url: '/policies',
      headers: authHeader('ADMIN'),
      payload: { nome: 'pra-filtro-booleano', payload: {} },
    });
    const { id } = criada.json<{ id: string }>();
    await app.inject({ method: 'DELETE', url: `/policies/${id}`, headers: authHeader('ADMIN') });

    const inativas = await app.inject({
      method: 'GET',
      url: '/policies?ativa=false',
      headers: authHeader('ADMIN'),
    });
    expect(inativas.json<{ id: string }[]>().some((p) => p.id === id)).toBe(true);

    const ativas = await app.inject({
      method: 'GET',
      url: '/policies?ativa=true',
      headers: authHeader('ADMIN'),
    });
    expect(ativas.json<{ id: string }[]>().some((p) => p.id === id)).toBe(false);
  });
});
