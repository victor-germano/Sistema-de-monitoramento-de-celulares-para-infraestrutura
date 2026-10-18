// Rotas de `/devices` e `/internal` (seção 10, Fase 4) — RBAC + comportamento
// básico contra um Postgres real. A chamada de rede à AMAPI feita por
// `POST /internal/sync/devices` é mockada (vi.mock do módulo adapter) —
// o objetivo aqui é a orquestração da rota, não repetir a cobertura já
// feita em `test/unit/amapi-devices.test.ts`.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as UsuariosSchemaModule from '../../src/db/schema/usuarios.ts';
import type * as EnrollmentHandlerModule from '../../src/domain/eventos/handlers/enrollment.ts';

const listarDispositivosAmapiMock = vi.fn();
vi.mock('../../src/integrations/amapi/devices.ts', () => ({
  listarDispositivos: listarDispositivosAmapiMock,
}));

type Role = 'VIEWER' | 'TECNICO' | 'ADMIN' | 'AUDITOR';
const TODOS_OS_PAPEIS: readonly Role[] = ['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'];
const tokensPorPapel = new Map<Role, string>();

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let app: FastifyInstance;
let db: typeof DbClientModule.db;
let usuarios: typeof UsuariosSchemaModule.usuarios;
let processarEnrollment: typeof EnrollmentHandlerModule.processarEnrollment;
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
  const { enrollmentTokens } = await import('../../src/db/schema/enrollment-tokens.ts');
  const { signSessionToken } = await import('../../src/domain/auth/session-tokens.ts');
  const { buildApp } = await import('../../src/app.ts');
  ({ processarEnrollment } = await import('../../src/domain/eventos/handlers/enrollment.ts'));

  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  const [admin] = await db
    .insert(usuarios)
    .values({
      oidcSubject: 'oidc-devroutes-admin',
      email: 'admin@gruporoveri.com.br',
      nome: 'Admin',
      role: 'ADMIN',
    })
    .returning();
  if (!admin) throw new Error('falha ao semear ADMIN');

  for (const role of TODOS_OS_PAPEIS) {
    if (role === 'ADMIN') {
      tokensPorPapel.set(
        role,
        await signSessionToken({ sub: admin.id, email: admin.email, role: 'ADMIN' }),
      );
      continue;
    }
    const [usuario] = await db
      .insert(usuarios)
      .values({
        oidcSubject: `oidc-devroutes-${role.toLowerCase()}`,
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

  // Um dispositivo real, criado pelo próprio handler de domínio (não um
  // INSERT direto) — mantém o fixture fiel ao que a Fase 4 realmente produz.
  const [token] = await db
    .insert(enrollmentTokens)
    .values({ valorHash: 'hash', expiraEm: new Date(Date.now() + 3_600_000), criadoPor: admin.id })
    .returning();
  if (!token) throw new Error('falha ao semear enrollment_token');

  const device = {
    name: 'enterprises/LC00000000000000000/devices/dev-rota',
    enrollmentTokenData: JSON.stringify({ tokenId: token.id }),
  };
  await db.transaction((tx) => processarEnrollment(tx, device));
  const [dispositivo] = await db
    .select()
    .from((await import('../../src/db/schema/dispositivos.ts')).dispositivos);
  if (!dispositivo) throw new Error('dispositivo de fixture não foi criado');
  dispositivoId = dispositivo.id;

  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
});

describe('GET /devices', () => {
  it('rejeita sem token', async () => {
    const response = await app.inject({ method: 'GET', url: '/devices' });
    expect(response.statusCode).toBe(401);
  });

  it.each(['VIEWER', 'TECNICO', 'ADMIN'] as const)('aceita leitura pro papel %s', async (role) => {
    const response = await app.inject({
      method: 'GET',
      url: '/devices',
      headers: authHeader(role),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ itens: unknown[] }>().itens).toHaveLength(1);
  });

  it('AUDITOR não acessa (ADR-004) — 403, mesmo sendo leitura', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/devices',
      headers: authHeader('AUDITOR'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejeita filtro inválido (querystring fora do schema) com 400', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/devices?politicaId=nao-e-uuid',
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /devices/:id', () => {
  it('404 pra id inexistente', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/devices/00000000-0000-7000-8000-000000000000',
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(404);
  });

  it('200 com o dispositivo de fixture', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/devices/${dispositivoId}`,
      headers: authHeader('VIEWER'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ id: string }>().id).toBe(dispositivoId);
  });

  // Achado verificando a tela de detalhe do frontend: `buscarDispositivoPorId`
  // não fazia o mesmo `leftJoin` com `colaboradores` que `listarDispositivos`
  // já fazia — o mesmo dispositivo aparecia com o nome do colaborador em
  // `GET /devices`, mas vazio em `GET /devices/:id`.
  it('inclui colaboradorNome quando o dispositivo tem colaborador vinculado — mesmo formato de GET /devices', async () => {
    const { colaboradores } = await import('../../src/db/schema/colaboradores.ts');
    const [colaborador] = await db
      .insert(colaboradores)
      .values({ matricula: 'MAT-GETID', nome: 'Colaborador de Teste' })
      .returning();
    if (!colaborador) throw new Error('falha ao semear colaborador');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/devices/${dispositivoId}`,
      headers: authHeader('ADMIN'),
      payload: { colaboradorId: colaborador.id },
    });
    expect(patch.statusCode).toBe(200);

    const response = await app.inject({
      method: 'GET',
      url: `/devices/${dispositivoId}`,
      headers: authHeader('VIEWER'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ colaboradorNome: string | null }>().colaboradorNome).toBe(
      'Colaborador de Teste',
    );
  });
});

describe('PATCH /devices/:id', () => {
  it.each(['VIEWER', 'AUDITOR'] as const)(
    'papel %s não pode alterar vínculo — 403',
    async (role) => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/devices/${dispositivoId}`,
        headers: authHeader(role),
        payload: { patrimonio: 'PAT-X' },
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it('TECNICO altera o vínculo e a auditoria registra a ação', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/devices/${dispositivoId}`,
      headers: authHeader('TECNICO'),
      payload: { patrimonio: 'PAT-NOVO', ativo: false },
    });
    expect(response.statusCode).toBe(200);
    const corpo = response.json<{ patrimonio: string; ativo: boolean }>();
    expect(corpo.patrimonio).toBe('PAT-NOVO');
    expect(corpo.ativo).toBe(false);

    const auditoria = await app.inject({
      method: 'GET',
      url: `/devices/${dispositivoId}/auditoria`,
      headers: authHeader('ADMIN'),
    });
    const linhasAuditoria = auditoria.json<{ acao: string }[]>();
    expect(linhasAuditoria.some((linha) => linha.acao === 'DISPOSITIVO_VINCULO_ALTERADO')).toBe(
      true,
    );
  });

  // Achado testando a edição manualmente no painel: a resposta do PATCH
  // vinha sem `colaboradorNome` (só o `UPDATE ... RETURNING` bruto, sem o
  // `leftJoin` que `buscarDispositivoPorId` já faz) — o frontend que reusa
  // essa resposta pra atualizar a tela sem um GET extra mostrava "—" mesmo
  // com o vínculo salvo certo no banco.
  it('a resposta do PATCH já vem com colaboradorNome, sem precisar de GET separado', async () => {
    const { colaboradores } = await import('../../src/db/schema/colaboradores.ts');
    const [colaborador] = await db
      .insert(colaboradores)
      .values({ matricula: 'MAT-PATCH', nome: 'Colaborador do PATCH' })
      .returning();
    if (!colaborador) throw new Error('falha ao semear colaborador');

    const response = await app.inject({
      method: 'PATCH',
      url: `/devices/${dispositivoId}`,
      headers: authHeader('ADMIN'),
      payload: { colaboradorId: colaborador.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ colaboradorNome: string | null }>().colaboradorNome).toBe(
      'Colaborador do PATCH',
    );
  });

  // Achado numa revisão: sem checar antes, isso batia direto no índice
  // único de `patrimonio` e quebrava com 500 genérico, em vez do 409
  // amigável que o mesmo padrão já usa pra matrícula/número.
  it('recusa com 409 (não 500) vincular um patrimônio já usado por outro dispositivo', async () => {
    const { dispositivos } = await import('../../src/db/schema/dispositivos.ts');
    const [outro] = await db
      .insert(dispositivos)
      .values({ amapiName: 'enterprises/x/devices/outro-dispositivo', patrimonio: 'PAT-JA-EXISTE' })
      .returning();
    if (!outro) throw new Error('setup falhou — segundo dispositivo não foi criado');

    const response = await app.inject({
      method: 'PATCH',
      url: `/devices/${dispositivoId}`,
      headers: authHeader('ADMIN'),
      payload: { patrimonio: 'PAT-JA-EXISTE' },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('GET /devices/:id/apps e /comandos', () => {
  it('devolve listas vazias pro dispositivo de fixture (sem STATUS_REPORT/comando ainda)', async () => {
    const apps = await app.inject({
      method: 'GET',
      url: `/devices/${dispositivoId}/apps`,
      headers: authHeader('VIEWER'),
    });
    expect(apps.statusCode).toBe(200);
    expect(apps.json()).toEqual([]);

    const comandos = await app.inject({
      method: 'GET',
      url: `/devices/${dispositivoId}/comandos`,
      headers: authHeader('VIEWER'),
    });
    expect(comandos.statusCode).toBe(200);
    expect(comandos.json()).toEqual([]);
  });

  it.each(['apps', 'comandos', 'auditoria'] as const)(
    'AUDITOR não acessa /devices/:id/%s (ADR-004)',
    async (subrecurso) => {
      const response = await app.inject({
        method: 'GET',
        url: `/devices/${dispositivoId}/${subrecurso}`,
        headers: authHeader('AUDITOR'),
      });
      expect(response.statusCode).toBe(403);
    },
  );
});

describe('GET /auditoria — único acesso do papel AUDITOR à trilha de auditoria (ADR-004)', () => {
  it('rejeita VIEWER/TECNICO com 403', async () => {
    for (const role of ['VIEWER', 'TECNICO'] as const) {
      const response = await app.inject({
        method: 'GET',
        url: '/auditoria',
        headers: authHeader(role),
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('AUDITOR e ADMIN acessam a visão global', async () => {
    for (const role of ['AUDITOR', 'ADMIN'] as const) {
      const response = await app.inject({
        method: 'GET',
        url: '/auditoria',
        headers: authHeader(role),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ itens: unknown[] }>().itens.length).toBeGreaterThan(0);
    }
  });

  it('filtra por entidade/entidadeId — mesmo resultado de /devices/:id/auditoria', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/auditoria?entidade=dispositivo&entidadeId=${dispositivoId}`,
      headers: authHeader('AUDITOR'),
    });
    expect(response.statusCode).toBe(200);
    const corpo = response.json<{ itens: { entidade: string; entidadeId: string }[] }>();
    expect(
      corpo.itens.every(
        (item) => item.entidade === 'dispositivo' && item.entidadeId === dispositivoId,
      ),
    ).toBe(true);
  });
});

describe('POST /internal/pubsub/replay', () => {
  it.each(['VIEWER', 'TECNICO', 'AUDITOR'] as const)(
    'só ADMIN pode chamar — papel %s recebe 403',
    async (role) => {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/pubsub/replay',
        headers: authHeader(role),
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it('ADMIN sem eventos pendentes recebe totalTentado 0', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/pubsub/replay',
      headers: authHeader('ADMIN'),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ totalTentado: number }>().totalTentado).toBe(0);
  });
});

describe('POST /internal/sync/devices', () => {
  it('só ADMIN pode chamar', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/sync/devices',
      headers: authHeader('VIEWER'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('reconcilia o device conhecido e ignora o desconhecido (sem ENROLLMENT prévio)', async () => {
    listarDispositivosAmapiMock.mockResolvedValueOnce({
      dispositivos: [
        { name: 'enterprises/LC00000000000000000/devices/dev-rota', policyCompliant: true },
        { name: 'enterprises/LC00000000000000000/devices/nunca-enrollado' },
      ],
      proximaPagina: undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/sync/devices',
      headers: authHeader('ADMIN'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ atualizado: 1, ignoradoSemEnrollment: 1, erro: 0 });
  });
});
