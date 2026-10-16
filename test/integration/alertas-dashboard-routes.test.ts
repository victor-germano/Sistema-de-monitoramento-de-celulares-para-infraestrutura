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

  it('filtra por ?aberto=false/true corretamente (achado numa revisão) — usa o alerta já resolvido acima', async () => {
    // z.coerce.boolean() fazia Boolean("false") === true — ?aberto=false
    // devolvia alerta ABERTO, o contrário do pedido.
    const resolvidos = await app.inject({
      method: 'GET',
      url: '/alertas?aberto=false',
      headers: authHeader('ADMIN'),
    });
    expect(
      resolvidos.json<{ itens: { id: string }[] }>().itens.some((a) => a.id === alertaId),
    ).toBe(true);

    const abertos = await app.inject({
      method: 'GET',
      url: '/alertas?aberto=true',
      headers: authHeader('ADMIN'),
    });
    expect(abertos.json<{ itens: { id: string }[] }>().itens.some((a) => a.id === alertaId)).toBe(
      false,
    );
  });
});

describe('GET /alertas — paginação por cursor avança de verdade (achado numa revisão)', () => {
  it('não repete a mesma página — cada chamada com cursor devolve itens novos', async () => {
    // listarAlertas ordenava desc(criadoEm) mas paginava com gt(id, cursor)
    // — direção invertida, "carregar mais" nunca saía da primeira página.
    for (let i = 0; i < 5; i++) {
      const dispositivo = await criarDispositivo(db, {
        amapiName: `enterprises/x/devices/paginacao-${i}`,
        ativo: true,
        complianceState: 'NON_COMPLIANT',
      });
      await verificarAlertasReativos(db, dispositivo);
    }

    const idsVistos = new Set<string>();
    let cursor: string | undefined;
    let paginas = 0;
    do {
      const url = cursor
        ? `/alertas?tipo=NAO_CONFORME&aberto=true&limit=2&cursor=${cursor}`
        : '/alertas?tipo=NAO_CONFORME&aberto=true&limit=2';
      const response = await app.inject({ method: 'GET', url, headers: authHeader('ADMIN') });
      const corpo = response.json<{ itens: { id: string }[]; proximoCursor: string | undefined }>();

      for (const item of corpo.itens) {
        expect(idsVistos.has(item.id)).toBe(false); // nunca um id repetido entre páginas
        idsVistos.add(item.id);
      }

      cursor = corpo.proximoCursor;
      paginas++;
    } while (cursor && paginas < 10); // teto de segurança — nunca deveria chegar perto disso

    expect(paginas).toBeGreaterThan(1); // prova que avançou de página de verdade
    expect(idsVistos.size).toBeGreaterThanOrEqual(5);
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

describe('GET /dashboard/export', () => {
  it('rejeita sem token', async () => {
    const response = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(response.statusCode).toBe(401);
  });

  it('gera um .xlsx de verdade, com os mesmos números do /dashboard JSON', async () => {
    const [resumoJson, exportResponse] = await Promise.all([
      app
        .inject({ method: 'GET', url: '/dashboard', headers: authHeader('ADMIN') })
        .then((r) =>
          r.json<{ dispositivos: { total: number }; alertasAbertos: { total: number } }>(),
        ),
      app.inject({
        method: 'GET',
        url: '/dashboard/export',
        headers: authHeader('VIEWER'),
      }),
    ]);

    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(exportResponse.headers['content-disposition']).toMatch(
      /^attachment; filename="dashboard-mdm-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );

    // Round-trip de verdade: carrega o buffer retornado como um .xlsx real
    // (não só confere os headers) e confirma que o número na planilha bate
    // com o que o endpoint JSON retornou — pega regressão de serialização
    // que um teste só de status code/headers não pegaria.
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    // `node_modules/exceljs/index.d.ts` declara globalmente
    // `interface Buffer extends ArrayBuffer {}`, contaminando o tipo `Buffer`
    // do projeto inteiro com um shape contraditório (bug conhecido da
    // biblioteca, não um erro de lógica aqui) — nenhum cast resolve isso de
    // forma limpa porque o próprio tipo global fica inconsistente.
    // @ts-expect-error — ver comentário acima; o valor em runtime é um
    // Buffer real, só a tipagem global do exceljs está quebrada.
    await workbook.xlsx.load(exportResponse.rawPayload);

    const nomesDasAbas = workbook.worksheets.map((aba) => aba.name);
    expect(nomesDasAbas).toEqual([
      'Resumo',
      'Dispositivos por conformidade',
      'Alertas por tipo',
      'Alertas por severidade',
      'Linhas por status',
    ]);

    const resumoAba = workbook.getWorksheet('Resumo');
    const linhaTotalDispositivos = resumoAba
      ?.getRows(2, resumoAba.rowCount - 1)
      ?.find((linha) => linha.getCell(1).text === 'Dispositivos — total');
    expect(linhaTotalDispositivos?.getCell(2).value).toBe(resumoJson.dispositivos.total);
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
