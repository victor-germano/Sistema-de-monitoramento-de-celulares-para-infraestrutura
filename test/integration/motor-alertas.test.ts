// Motor de alertas (Fase 6) contra Postgres real: os 5 tipos reativos
// (chamados via `verificarAlertasReativos`, mesma função que
// `processarStatusReport` usa — testado direto contra um `Dispositivo` já
// montado, sem precisar repetir o round-trip do mapper AMAPI) e os 3
// periódicos (scan da frota inteira). Mais a purga LGPD de `eventos_brutos`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as DispositivosSchemaModule from '../../src/db/schema/dispositivos.ts';
import type * as AlertasSchemaModule from '../../src/db/schema/alertas.ts';
import type * as LinhasSchemaModule from '../../src/db/schema/linhas.ts';
import type * as EventosBrutosSchemaModule from '../../src/db/schema/eventos-brutos.ts';
import type * as MotorModule from '../../src/domain/alertas/motor.ts';
import type * as DispositivosRepoModule from '../../src/domain/dispositivos/repositorio.ts';
import type * as LgpdModule from '../../src/domain/lgpd/retencao.ts';

let postgresContainer: StartedPostgreSqlContainer;
let db: typeof DbClientModule.db;
let dispositivos: typeof DispositivosSchemaModule.dispositivos;
let alertas: typeof AlertasSchemaModule.alertas;
let linhas: typeof LinhasSchemaModule.linhas;
let eventosBrutos: typeof EventosBrutosSchemaModule.eventosBrutos;
let verificarAlertasReativos: typeof MotorModule.verificarAlertasReativos;
let verificarDispositivosSemCheckin: typeof MotorModule.verificarDispositivosSemCheckin;
let verificarDispositivosOrfaos: typeof MotorModule.verificarDispositivosOrfaos;
let verificarLinhasSemUso: typeof MotorModule.verificarLinhasSemUso;
let criarDispositivo: typeof DispositivosRepoModule.criarDispositivo;
let purgarEventosBrutosAntigos: typeof LgpdModule.purgarEventosBrutosAntigos;

function diasAtras(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function dataIso(n: number): string {
  return diasAtras(n).toISOString().slice(0, 10);
}

beforeAll(async () => {
  postgresContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = postgresContainer.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6379';

  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  ({ db } = await import('../../src/db/client.ts'));
  ({ dispositivos } = await import('../../src/db/schema/dispositivos.ts'));
  ({ alertas } = await import('../../src/db/schema/alertas.ts'));
  ({ linhas } = await import('../../src/db/schema/linhas.ts'));
  ({ eventosBrutos } = await import('../../src/db/schema/eventos-brutos.ts'));
  ({
    verificarAlertasReativos,
    verificarDispositivosSemCheckin,
    verificarDispositivosOrfaos,
    verificarLinhasSemUso,
  } = await import('../../src/domain/alertas/motor.ts'));
  ({ criarDispositivo } = await import('../../src/domain/dispositivos/repositorio.ts'));
  ({ purgarEventosBrutosAntigos } = await import('../../src/domain/lgpd/retencao.ts'));

  await migrate(db, { migrationsFolder: './drizzle/migrations' });
}, 60_000);

afterAll(async () => {
  await postgresContainer?.stop();
});

beforeEach(async () => {
  await db.delete(alertas);
  await db.delete(dispositivos);
  await db.delete(linhas);
  await db.delete(eventosBrutos);
});

async function semearDispositivo(overrides: Partial<typeof dispositivos.$inferInsert> = {}) {
  return criarDispositivo(db, {
    amapiName: `enterprises/x/devices/${Math.random()}`,
    ativo: true,
    ...overrides,
  });
}

async function alertaAberto(dispositivoId: string, tipo: (typeof alertas.$inferSelect)['tipo']) {
  const [linha] = await db
    .select()
    .from(alertas)
    .where(and(eq(alertas.dispositivoId, dispositivoId), eq(alertas.tipo, tipo)));
  return linha;
}

describe('verificarAlertasReativos — NAO_CONFORME', () => {
  it('abre quando complianceState é NON_COMPLIANT', async () => {
    const dispositivo = await semearDispositivo({ complianceState: 'NON_COMPLIANT' });
    await verificarAlertasReativos(db, dispositivo);
    const alerta = await alertaAberto(dispositivo.id, 'NAO_CONFORME');
    expect(alerta?.resolvidoEm).toBeNull();
    expect(alerta?.severidade).toBe('ALTA');
  });

  it('resolve sozinho quando volta a ficar COMPLIANT', async () => {
    const dispositivo = await semearDispositivo({ complianceState: 'NON_COMPLIANT' });
    await verificarAlertasReativos(db, dispositivo);

    await verificarAlertasReativos(db, { ...dispositivo, complianceState: 'COMPLIANT' });
    const alerta = await alertaAberto(dispositivo.id, 'NAO_CONFORME');
    expect(alerta?.resolvidoEm).not.toBeNull();
  });

  it('não abre quando compliance é COMPLIANT desde o início', async () => {
    const dispositivo = await semearDispositivo({ complianceState: 'COMPLIANT' });
    await verificarAlertasReativos(db, dispositivo);
    expect(await alertaAberto(dispositivo.id, 'NAO_CONFORME')).toBeUndefined();
  });
});

describe('verificarAlertasReativos — PATCH_DESATUALIZADO', () => {
  it('abre quando o patch tem mais que o limite (default 90 dias)', async () => {
    const dispositivo = await semearDispositivo({ patchSeguranca: dataIso(100) });
    await verificarAlertasReativos(db, dispositivo);
    expect((await alertaAberto(dispositivo.id, 'PATCH_DESATUALIZADO'))?.resolvidoEm).toBeNull();
  });

  it('não abre quando o patch é recente', async () => {
    const dispositivo = await semearDispositivo({ patchSeguranca: dataIso(5) });
    await verificarAlertasReativos(db, dispositivo);
    expect(await alertaAberto(dispositivo.id, 'PATCH_DESATUALIZADO')).toBeUndefined();
  });

  it('não afirma nada sem dado de patch', async () => {
    const dispositivo = await semearDispositivo({ patchSeguranca: null });
    await verificarAlertasReativos(db, dispositivo);
    expect(await alertaAberto(dispositivo.id, 'PATCH_DESATUALIZADO')).toBeUndefined();
  });
});

describe('verificarAlertasReativos — SO_OBSOLETO', () => {
  it('abre quando a versão major é menor que o mínimo aceito (SDK 30 = Android 11)', async () => {
    const dispositivo = await semearDispositivo({ versaoSo: '9' });
    await verificarAlertasReativos(db, dispositivo);
    expect((await alertaAberto(dispositivo.id, 'SO_OBSOLETO'))?.resolvidoEm).toBeNull();
  });

  it('não abre quando a versão atende o mínimo', async () => {
    const dispositivo = await semearDispositivo({ versaoSo: '14' });
    await verificarAlertasReativos(db, dispositivo);
    expect(await alertaAberto(dispositivo.id, 'SO_OBSOLETO')).toBeUndefined();
  });
});

describe('verificarAlertasReativos — STORAGE_CRITICO', () => {
  it('abre quando storage livre está abaixo do limite (default 500MB)', async () => {
    const dispositivo = await semearDispositivo({ storageLivreMb: 100 });
    await verificarAlertasReativos(db, dispositivo);
    expect((await alertaAberto(dispositivo.id, 'STORAGE_CRITICO'))?.severidade).toBe('ALTA');
  });

  it('resolve quando o storage é liberado', async () => {
    const dispositivo = await semearDispositivo({ storageLivreMb: 100 });
    await verificarAlertasReativos(db, dispositivo);
    await verificarAlertasReativos(db, { ...dispositivo, storageLivreMb: 5000 });
    expect((await alertaAberto(dispositivo.id, 'STORAGE_CRITICO'))?.resolvidoEm).not.toBeNull();
  });
});

describe('verificarAlertasReativos — BATERIA_DEGRADADA (proxy: carga crítica, ver ADR-027)', () => {
  it('abre quando a bateria está abaixo do limite (default 15%)', async () => {
    const dispositivo = await semearDispositivo({ bateriaPct: 5 });
    await verificarAlertasReativos(db, dispositivo);
    expect((await alertaAberto(dispositivo.id, 'BATERIA_DEGRADADA'))?.severidade).toBe('BAIXA');
  });

  it('não abre com bateria saudável', async () => {
    const dispositivo = await semearDispositivo({ bateriaPct: 80 });
    await verificarAlertasReativos(db, dispositivo);
    expect(await alertaAberto(dispositivo.id, 'BATERIA_DEGRADADA')).toBeUndefined();
  });
});

describe('verificarDispositivosSemCheckin (scan periódico)', () => {
  it('abre pra dispositivo ativo sem check-in há mais que o limite, e resolve quando ele volta', async () => {
    const dispositivo = await semearDispositivo({ ultimoCheckin: diasAtras(10) });

    const primeiraRodada = await verificarDispositivosSemCheckin();
    expect(primeiraRodada.abertos).toBe(1);
    expect((await alertaAberto(dispositivo.id, 'SEM_CHECKIN'))?.resolvidoEm).toBeNull();

    await db
      .update(dispositivos)
      .set({ ultimoCheckin: new Date() })
      .where(eq(dispositivos.id, dispositivo.id));
    const segundaRodada = await verificarDispositivosSemCheckin();
    expect(segundaRodada.resolvidos).toBe(1);
    expect((await alertaAberto(dispositivo.id, 'SEM_CHECKIN'))?.resolvidoEm).not.toBeNull();
  });

  it('conta dispositivo que nunca reportou (ultimo_checkin null) como candidato', async () => {
    await semearDispositivo({ ultimoCheckin: null });
    const resultado = await verificarDispositivosSemCheckin();
    expect(resultado.abertos).toBe(1);
  });

  it('ignora dispositivo inativo', async () => {
    await semearDispositivo({ ultimoCheckin: diasAtras(30), ativo: false });
    const resultado = await verificarDispositivosSemCheckin();
    expect(resultado.candidatos).toBe(0);
  });
});

describe('verificarDispositivosOrfaos (scan periódico)', () => {
  it('abre pra dispositivo ativo sem colaborador há mais que o limite (default 7 dias)', async () => {
    const dispositivo = await semearDispositivo({ colaboradorId: null });
    await db
      .update(dispositivos)
      .set({ criadoEm: diasAtras(10) })
      .where(eq(dispositivos.id, dispositivo.id));

    const resultado = await verificarDispositivosOrfaos();
    expect(resultado.abertos).toBe(1);
  });

  it('não abre pra dispositivo recém-criado, mesmo sem colaborador', async () => {
    await semearDispositivo({ colaboradorId: null });
    const resultado = await verificarDispositivosOrfaos();
    expect(resultado.candidatos).toBe(0);
  });
});

describe('verificarLinhasSemUso (scan periódico)', () => {
  it('abre alerta com linhaId (não dispositivoId) pra linha ativa sem dispositivo', async () => {
    const [linha] = await db
      .insert(linhas)
      .values({ numero: '+5511900000000', status: 'ativa' })
      .returning();
    if (!linha) throw new Error('setup falhou');

    const resultado = await verificarLinhasSemUso();
    expect(resultado.abertos).toBe(1);

    const [alerta] = await db.select().from(alertas).where(eq(alertas.linhaId, linha.id));
    expect(alerta?.dispositivoId).toBeNull();
    expect(alerta?.tipo).toBe('LINHA_SEM_USO');
  });

  it('resolve quando um dispositivo passa a usar a linha', async () => {
    const [linha] = await db
      .insert(linhas)
      .values({ numero: '+5511900000001', status: 'ativa' })
      .returning();
    if (!linha) throw new Error('setup falhou');
    await verificarLinhasSemUso();

    await semearDispositivo({ linhaId: linha.id });
    const resultado = await verificarLinhasSemUso();
    expect(resultado.resolvidos).toBe(1);
  });

  it('ignora linha suspensa/cancelada', async () => {
    await db.insert(linhas).values({ numero: '+5511900000002', status: 'suspensa' });
    const resultado = await verificarLinhasSemUso();
    expect(resultado.candidatos).toBe(0);
  });
});

describe('purgarEventosBrutosAntigos (LGPD)', () => {
  it('purga só eventos processados com sucesso há mais que o limite (default 180 dias)', async () => {
    await db.insert(eventosBrutos).values([
      {
        messageId: 'antigo-processado',
        notificationType: 'STATUS_REPORT',
        payload: {},
        processadoEm: diasAtras(200),
      },
      {
        messageId: 'recente-processado',
        notificationType: 'STATUS_REPORT',
        payload: {},
        processadoEm: diasAtras(5),
      },
      {
        messageId: 'antigo-com-erro',
        notificationType: 'STATUS_REPORT',
        payload: {},
        erro: 'falhou',
        processadoEm: null,
      },
    ]);

    const quantidade = await purgarEventosBrutosAntigos();
    expect(quantidade).toBe(1);

    const restantes = await db.select({ messageId: eventosBrutos.messageId }).from(eventosBrutos);
    expect(restantes.map((r) => r.messageId).sort()).toEqual([
      'antigo-com-erro',
      'recente-processado',
    ]);
  });
});
