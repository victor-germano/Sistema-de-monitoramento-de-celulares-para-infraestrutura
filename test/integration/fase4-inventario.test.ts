// Cobre o critério de aceite explícito da Fase 4: "enrollment de device de
// teste popula o banco com o vínculo correto, sozinho" — mais o handler
// STATUS_REPORT (atualização + upsert de apps + alerta
// APP_OBRIGATORIO_AUSENTE) e o dispatcher compartilhado
// (`processarEventoBruto`) usado tanto pelo consumer quanto pelo replay.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, or } from 'drizzle-orm';
import type { androidmanagement_v1 } from 'googleapis';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as UsuariosSchemaModule from '../../src/db/schema/usuarios.ts';
import type * as PoliticasSchemaModule from '../../src/db/schema/politicas.ts';
import type * as ColaboradoresSchemaModule from '../../src/db/schema/colaboradores.ts';
import type * as EnrollmentTokensSchemaModule from '../../src/db/schema/enrollment-tokens.ts';
import type * as DispositivosSchemaModule from '../../src/db/schema/dispositivos.ts';
import type * as AlertasSchemaModule from '../../src/db/schema/alertas.ts';
import type * as EventosBrutosSchemaModule from '../../src/db/schema/eventos-brutos.ts';
import type * as EnrollmentHandlerModule from '../../src/domain/eventos/handlers/enrollment.ts';
import type * as StatusReportHandlerModule from '../../src/domain/eventos/handlers/status-report.ts';
import type * as ProcessarEventoModule from '../../src/domain/eventos/processar-evento.ts';

type Device = androidmanagement_v1.Schema$Device;

let postgresContainer: StartedPostgreSqlContainer;
let db: typeof DbClientModule.db;
let usuarios: typeof UsuariosSchemaModule.usuarios;
let politicas: typeof PoliticasSchemaModule.politicas;
let colaboradores: typeof ColaboradoresSchemaModule.colaboradores;
let enrollmentTokens: typeof EnrollmentTokensSchemaModule.enrollmentTokens;
let dispositivos: typeof DispositivosSchemaModule.dispositivos;
let dispositivoApps: typeof DispositivosSchemaModule.dispositivoApps;
let alertas: typeof AlertasSchemaModule.alertas;
let eventosBrutos: typeof EventosBrutosSchemaModule.eventosBrutos;
let processarEnrollment: typeof EnrollmentHandlerModule.processarEnrollment;
let EnrollmentTokenInvalidoError: typeof EnrollmentHandlerModule.EnrollmentTokenInvalidoError;
let processarStatusReport: typeof StatusReportHandlerModule.processarStatusReport;
let DispositivoDesconhecidoError: typeof StatusReportHandlerModule.DispositivoDesconhecidoError;
let processarEventoBruto: typeof ProcessarEventoModule.processarEventoBruto;

let usuarioId: string;

beforeAll(async () => {
  postgresContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = postgresContainer.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6379';

  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  ({ db } = await import('../../src/db/client.ts'));
  ({ usuarios } = await import('../../src/db/schema/usuarios.ts'));
  ({ politicas } = await import('../../src/db/schema/politicas.ts'));
  ({ colaboradores } = await import('../../src/db/schema/colaboradores.ts'));
  ({ enrollmentTokens } = await import('../../src/db/schema/enrollment-tokens.ts'));
  ({ dispositivos, dispositivoApps } = await import('../../src/db/schema/dispositivos.ts'));
  ({ alertas } = await import('../../src/db/schema/alertas.ts'));
  ({ eventosBrutos } = await import('../../src/db/schema/eventos-brutos.ts'));
  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  ({ processarEnrollment, EnrollmentTokenInvalidoError } =
    await import('../../src/domain/eventos/handlers/enrollment.ts'));
  ({ processarStatusReport, DispositivoDesconhecidoError } =
    await import('../../src/domain/eventos/handlers/status-report.ts'));
  ({ processarEventoBruto } = await import('../../src/domain/eventos/processar-evento.ts'));

  const [usuario] = await db
    .insert(usuarios)
    .values({ oidcSubject: 'oidc-fase4', email: 'fase4@gruporoveri.com.br', nome: 'Teste Fase 4' })
    .returning();
  if (!usuario) throw new Error('falha ao semear usuário de teste');
  usuarioId = usuario.id;
}, 60_000);

afterAll(async () => {
  await postgresContainer?.stop();
});

// Limpa as tabelas tocadas por este arquivo entre testes — mais barato que
// recriar o container, e evita um teste contaminar o cursor/estado do outro
// (`amapi_name`/`patrimonio` são UNIQUE em `dispositivos`).
beforeEach(async () => {
  await db.delete(alertas);
  await db.delete(dispositivoApps);
  await db.delete(eventosBrutos);
  await db.delete(enrollmentTokens);
  await db.delete(dispositivos);
  await db.delete(politicas);
  await db.delete(colaboradores);
});

async function semearColaborador(): Promise<string> {
  const [colaborador] = await db
    .insert(colaboradores)
    .values({ matricula: `mat-${Date.now()}-${Math.random()}`, nome: 'Colaborador Teste' })
    .returning();
  if (!colaborador) throw new Error('falha ao semear colaborador');
  return colaborador.id;
}

async function semearPoliticaComAppObrigatorio(packageName: string): Promise<string> {
  const [politica] = await db
    .insert(politicas)
    .values({
      nome: `politica-${Date.now()}-${Math.random()}`,
      payload: { applications: [{ packageName, installType: 'FORCE_INSTALLED' }] },
      criadoPor: usuarioId,
    })
    .returning();
  if (!politica) throw new Error('falha ao semear política');
  return politica.id;
}

async function semearEnrollmentToken(opcoes: {
  politicaId?: string;
  colaboradorId?: string;
  patrimonio?: string;
  usadoEm?: Date;
}): Promise<{ id: string }> {
  const [token] = await db
    .insert(enrollmentTokens)
    .values({
      valorHash: 'hash-fake',
      expiraEm: new Date(Date.now() + 60 * 60 * 1000),
      criadoPor: usuarioId,
      politicaId: opcoes.politicaId,
      colaboradorId: opcoes.colaboradorId,
      patrimonio: opcoes.patrimonio,
      usadoEm: opcoes.usadoEm,
    })
    .returning();
  if (!token) throw new Error('falha ao semear enrollment_token');
  return token;
}

describe('processarEnrollment — critério de aceite da Fase 4', () => {
  it('popula dispositivos com o vínculo correto a partir de um enrollment_token, sozinho', async () => {
    const colaboradorId = await semearColaborador();
    const politicaId = await semearPoliticaComAppObrigatorio('com.empresa.obrigatorio');
    const token = await semearEnrollmentToken({ politicaId, colaboradorId, patrimonio: 'PAT-001' });

    const device: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-1',
      enrollmentTokenData: JSON.stringify({ tokenId: token.id }),
      networkInfo: { imei: '111122223333444' },
      hardwareInfo: { serialNumber: 'SN-001', manufacturer: 'Samsung', model: 'Galaxy A54' },
      softwareInfo: { androidVersion: '14' },
      state: 'ACTIVE',
    };

    await db.transaction((tx) => processarEnrollment(tx, device));

    const [dispositivo] = await db
      .select()
      .from(dispositivos)
      .where(eq(dispositivos.amapiName, device.name!));
    expect(dispositivo).toBeDefined();
    expect(dispositivo?.colaboradorId).toBe(colaboradorId);
    expect(dispositivo?.politicaId).toBe(politicaId);
    expect(dispositivo?.patrimonio).toBe('PAT-001');
    expect(dispositivo?.imei).toBe('111122223333444');
    expect(dispositivo?.ativo).toBe(true); // default (ADR-018)

    const [tokenAtualizado] = await db
      .select()
      .from(enrollmentTokens)
      .where(eq(enrollmentTokens.id, token.id));
    expect(tokenAtualizado?.usadoEm).toBeInstanceOf(Date);
    expect(tokenAtualizado?.dispositivoId).toBe(dispositivo?.id);
  });

  it('additionalData vence o que já estava gravado no token, quando os dois existem', async () => {
    const colaboradorDoToken = await semearColaborador();
    const colaboradorDoAdditionalData = await semearColaborador();
    const token = await semearEnrollmentToken({
      colaboradorId: colaboradorDoToken,
      patrimonio: 'PAT-TOKEN',
    });

    const device: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-2',
      enrollmentTokenData: JSON.stringify({
        tokenId: token.id,
        colaboradorId: colaboradorDoAdditionalData,
        patrimonio: 'PAT-ADDITIONAL',
      }),
    };

    await db.transaction((tx) => processarEnrollment(tx, device));

    const [dispositivo] = await db
      .select()
      .from(dispositivos)
      .where(eq(dispositivos.amapiName, device.name!));
    expect(dispositivo?.colaboradorId).toBe(colaboradorDoAdditionalData);
    expect(dispositivo?.patrimonio).toBe('PAT-ADDITIONAL');
  });

  it('é idempotente — reprocessar o mesmo device (redelivery) não duplica nem lança', async () => {
    const token = await semearEnrollmentToken({});
    const device: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-3',
      enrollmentTokenData: JSON.stringify({ tokenId: token.id }),
    };

    await db.transaction((tx) => processarEnrollment(tx, device));
    await expect(db.transaction((tx) => processarEnrollment(tx, device))).resolves.toBeUndefined();

    const linhas = await db
      .select()
      .from(dispositivos)
      .where(eq(dispositivos.amapiName, device.name!));
    expect(linhas).toHaveLength(1);
  });

  it('rejeita device sem enrollmentTokenData', async () => {
    const device: Device = { name: 'enterprises/x/devices/dev-4' };
    await expect(db.transaction((tx) => processarEnrollment(tx, device))).rejects.toBeInstanceOf(
      EnrollmentTokenInvalidoError,
    );
  });

  it('rejeita enrollmentTokenData que não é JSON válido', async () => {
    const device: Device = {
      name: 'enterprises/x/devices/dev-5',
      enrollmentTokenData: 'não-é-json{',
    };
    await expect(db.transaction((tx) => processarEnrollment(tx, device))).rejects.toBeInstanceOf(
      EnrollmentTokenInvalidoError,
    );
  });

  it('rejeita tokenId que não existe em enrollment_tokens', async () => {
    const device: Device = {
      name: 'enterprises/x/devices/dev-6',
      enrollmentTokenData: JSON.stringify({ tokenId: '00000000-0000-7000-8000-000000000000' }),
    };
    await expect(db.transaction((tx) => processarEnrollment(tx, device))).rejects.toBeInstanceOf(
      EnrollmentTokenInvalidoError,
    );
  });

  it('rejeita token já usado (defesa em profundidade além do oneTimeOnly da AMAPI)', async () => {
    const token = await semearEnrollmentToken({ usadoEm: new Date() });
    const device: Device = {
      name: 'enterprises/x/devices/dev-7',
      enrollmentTokenData: JSON.stringify({ tokenId: token.id }),
    };
    await expect(db.transaction((tx) => processarEnrollment(tx, device))).rejects.toBeInstanceOf(
      EnrollmentTokenInvalidoError,
    );
  });

  // Achado numa revisão: SELECT + checar `usadoEm` + UPDATE depois não é
  // atômico — duas transações concorrentes pro MESMO token podiam as duas
  // passar o check antes de qualquer UPDATE comitar. Corrigido com um
  // UPDATE ... WHERE usado_em IS NULL atômico (ver enrollment.ts). Este
  // teste dispara duas transações de verdade em paralelo contra o Postgres
  // real — não simula a corrida, deixa ela acontecer.
  it('duas mensagens ENROLLMENT concorrentes pro mesmo token: só UMA cria dispositivo', async () => {
    const token = await semearEnrollmentToken({});
    const deviceA: Device = {
      name: 'enterprises/x/devices/corrida-a',
      enrollmentTokenData: JSON.stringify({ tokenId: token.id }),
    };
    const deviceB: Device = {
      name: 'enterprises/x/devices/corrida-b',
      enrollmentTokenData: JSON.stringify({ tokenId: token.id }),
    };

    const resultados = await Promise.allSettled([
      db.transaction((tx) => processarEnrollment(tx, deviceA)),
      db.transaction((tx) => processarEnrollment(tx, deviceB)),
    ]);

    const sucessos = resultados.filter((r) => r.status === 'fulfilled');
    const falhas = resultados.filter((r) => r.status === 'rejected');
    expect(sucessos).toHaveLength(1);
    expect(falhas).toHaveLength(1);
    expect((falhas[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      EnrollmentTokenInvalidoError,
    );

    // Só o device da chamada que venceu a corrida existe — nunca os dois.
    const dispositivosCriados = await db
      .select()
      .from(dispositivos)
      .where(
        or(eq(dispositivos.amapiName, deviceA.name!), eq(dispositivos.amapiName, deviceB.name!)),
      );
    expect(dispositivosCriados).toHaveLength(1);
  });
});

describe('processarStatusReport', () => {
  async function semearDispositivoEnrollado(politicaId?: string): Promise<string> {
    const token = await semearEnrollmentToken({ politicaId });
    const device: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-status',
      enrollmentTokenData: JSON.stringify({ tokenId: token.id }),
    };
    await db.transaction((tx) => processarEnrollment(tx, device));
    const [dispositivo] = await db
      .select()
      .from(dispositivos)
      .where(eq(dispositivos.amapiName, device.name!));
    if (!dispositivo) throw new Error('setup falhou');
    return dispositivo.id;
  }

  it('atualiza campos do dispositivo e faz upsert dos apps reportados', async () => {
    const dispositivoId = await semearDispositivoEnrollado();
    const device: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-status',
      policyCompliant: true,
      softwareInfo: { androidVersion: '14', securityPatchLevel: '2026-09-01' },
      applicationReports: [
        {
          packageName: 'com.empresa.app',
          displayName: 'App',
          versionName: '2.0',
          state: 'INSTALLED',
        },
      ],
    };

    await db.transaction((tx) => processarStatusReport(tx, device));

    const [dispositivo] = await db
      .select()
      .from(dispositivos)
      .where(eq(dispositivos.id, dispositivoId));
    expect(dispositivo?.versaoSo).toBe('14');
    expect(dispositivo?.complianceState).toBe('COMPLIANT');
    expect(dispositivo?.ultimoCheckin).toBeInstanceOf(Date);

    const apps = await db
      .select()
      .from(dispositivoApps)
      .where(eq(dispositivoApps.dispositivoId, dispositivoId));
    expect(apps).toHaveLength(1);
    expect(apps[0]?.packageName).toBe('com.empresa.app');
  });

  it('abre APP_OBRIGATORIO_AUSENTE quando falta um app FORCE_INSTALLED da política', async () => {
    const politicaId = await semearPoliticaComAppObrigatorio('com.empresa.obrigatorio');
    const dispositivoId = await semearDispositivoEnrollado(politicaId);

    const device: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-status',
      applicationReports: [], // app obrigatório NÃO está instalado
    };
    await db.transaction((tx) => processarStatusReport(tx, device));

    const abertos = await db.select().from(alertas).where(eq(alertas.dispositivoId, dispositivoId));
    expect(abertos).toHaveLength(1);
    expect(abertos[0]?.tipo).toBe('APP_OBRIGATORIO_AUSENTE');
    expect(abertos[0]?.resolvidoEm).toBeNull();
  });

  it('não duplica o alerta em STATUS_REPORTs consecutivos com o mesmo app ausente (ADR-020)', async () => {
    const politicaId = await semearPoliticaComAppObrigatorio('com.empresa.obrigatorio');
    const dispositivoId = await semearDispositivoEnrollado(politicaId);
    const device: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-status',
      applicationReports: [],
    };

    await db.transaction((tx) => processarStatusReport(tx, device));
    await db.transaction((tx) => processarStatusReport(tx, device));

    const abertos = await db.select().from(alertas).where(eq(alertas.dispositivoId, dispositivoId));
    expect(abertos).toHaveLength(1);
  });

  it('não abre alerta quando o app obrigatório está presente', async () => {
    const politicaId = await semearPoliticaComAppObrigatorio('com.empresa.obrigatorio');
    const dispositivoId = await semearDispositivoEnrollado(politicaId);
    const device: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-status',
      applicationReports: [{ packageName: 'com.empresa.obrigatorio' }],
    };

    await db.transaction((tx) => processarStatusReport(tx, device));

    const abertos = await db.select().from(alertas).where(eq(alertas.dispositivoId, dispositivoId));
    expect(abertos).toHaveLength(0);
  });

  it('rejeita STATUS_REPORT de um device nunca enrollado', async () => {
    const device: Device = { name: 'enterprises/x/devices/nunca-existiu' };
    await expect(db.transaction((tx) => processarStatusReport(tx, device))).rejects.toBeInstanceOf(
      DispositivoDesconhecidoError,
    );
  });

  // Achado numa revisão: upsertDispositivoApps só fazia upsert, nunca
  // removia — um app desinstalado deixava uma linha "fantasma" pra sempre,
  // mascarando APP_OBRIGATORIO_AUSENTE mesmo com o app de verdade ausente.
  it('remove do inventário um app que não aparece mais no STATUS_REPORT', async () => {
    const dispositivoId = await semearDispositivoEnrollado();
    const deviceComApp: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-status',
      applicationReports: [{ packageName: 'com.empresa.removido' }],
    };
    await db.transaction((tx) => processarStatusReport(tx, deviceComApp));
    expect(
      await db
        .select()
        .from(dispositivoApps)
        .where(eq(dispositivoApps.dispositivoId, dispositivoId)),
    ).toHaveLength(1);

    const deviceSemApp: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-status',
      applicationReports: [],
    };
    await db.transaction((tx) => processarStatusReport(tx, deviceSemApp));

    expect(
      await db
        .select()
        .from(dispositivoApps)
        .where(eq(dispositivoApps.dispositivoId, dispositivoId)),
    ).toHaveLength(0);
  });

  it('um app obrigatório desinstalado (removido do relatório) é detectado como ausente', async () => {
    const politicaId = await semearPoliticaComAppObrigatorio('com.empresa.obrigatorio');
    const dispositivoId = await semearDispositivoEnrollado(politicaId);

    await db.transaction((tx) =>
      processarStatusReport(tx, {
        name: 'enterprises/LC00000000000000000/devices/dev-status',
        applicationReports: [{ packageName: 'com.empresa.obrigatorio' }],
      }),
    );
    expect(
      await db.select().from(alertas).where(eq(alertas.dispositivoId, dispositivoId)),
    ).toHaveLength(0);

    // App "desinstalado": próximo relatório não lista mais o pacote.
    await db.transaction((tx) =>
      processarStatusReport(tx, {
        name: 'enterprises/LC00000000000000000/devices/dev-status',
        applicationReports: [],
      }),
    );

    const abertos = await db.select().from(alertas).where(eq(alertas.dispositivoId, dispositivoId));
    expect(abertos).toHaveLength(1);
    expect(abertos[0]?.tipo).toBe('APP_OBRIGATORIO_AUSENTE');
  });

  // Achado numa revisão: as duas saídas antecipadas de verificarAppsObrigatorios
  // (sem política vinculada; política sem app obrigatório nenhum) nunca
  // chegavam no resolverAlertaSeAberto — o alerta ficava aberto pra sempre.
  describe('APP_OBRIGATORIO_AUSENTE se resolve sozinho quando o motivo desaparece', () => {
    async function abrirAlertaDeAppAusente(politicaId: string): Promise<string> {
      const dispositivoId = await semearDispositivoEnrollado(politicaId);
      await db.transaction((tx) =>
        processarStatusReport(tx, {
          name: 'enterprises/LC00000000000000000/devices/dev-status',
          applicationReports: [],
        }),
      );
      const [alerta] = await db
        .select()
        .from(alertas)
        .where(eq(alertas.dispositivoId, dispositivoId));
      if (!alerta) throw new Error('setup falhou — alerta não abriu');
      return dispositivoId;
    }

    it('resolve quando o device é desvinculado da política (politicaId vira null)', async () => {
      const politicaId = await semearPoliticaComAppObrigatorio('com.empresa.obrigatorio');
      const dispositivoId = await abrirAlertaDeAppAusente(politicaId);

      await db
        .update(dispositivos)
        .set({ politicaId: null })
        .where(eq(dispositivos.id, dispositivoId));
      await db.transaction((tx) =>
        processarStatusReport(tx, { name: 'enterprises/LC00000000000000000/devices/dev-status' }),
      );

      const [alerta] = await db
        .select()
        .from(alertas)
        .where(eq(alertas.dispositivoId, dispositivoId));
      expect(alerta?.resolvidoEm).not.toBeNull();
    });

    it('resolve quando a política deixa de exigir qualquer app FORCE_INSTALLED', async () => {
      const politicaId = await semearPoliticaComAppObrigatorio('com.empresa.obrigatorio');
      const dispositivoId = await abrirAlertaDeAppAusente(politicaId);

      await db
        .update(politicas)
        .set({ payload: { applications: [] } })
        .where(eq(politicas.id, politicaId));
      await db.transaction((tx) =>
        processarStatusReport(tx, { name: 'enterprises/LC00000000000000000/devices/dev-status' }),
      );

      const [alerta] = await db
        .select()
        .from(alertas)
        .where(eq(alertas.dispositivoId, dispositivoId));
      expect(alerta?.resolvidoEm).not.toBeNull();
    });
  });
});

describe('processarEventoBruto — núcleo compartilhado com o replay', () => {
  it('processa um ENROLLMENT e marca processado_em', async () => {
    const token = await semearEnrollmentToken({});
    const device: Device = {
      name: 'enterprises/LC00000000000000000/devices/dev-evento',
      enrollmentTokenData: JSON.stringify({ tokenId: token.id }),
    };

    const [evento] = await db
      .insert(eventosBrutos)
      .values({
        messageId: 'msg-1',
        notificationType: 'ENROLLMENT',
        payload: { attributes: { notificationType: 'ENROLLMENT' }, data: device },
      })
      .returning();
    if (!evento) throw new Error('setup falhou');

    const resultado = await processarEventoBruto(evento.id);
    expect(resultado.status).toBe('processado');

    const [eventoAtualizado] = await db
      .select()
      .from(eventosBrutos)
      .where(eq(eventosBrutos.id, evento.id));
    expect(eventoAtualizado?.processadoEm).toBeInstanceOf(Date);
    expect(eventoAtualizado?.erro).toBeNull();

    const [dispositivo] = await db
      .select()
      .from(dispositivos)
      .where(eq(dispositivos.amapiName, device.name!));
    expect(dispositivo).toBeDefined();
  });

  it('retorna sem_handler para um notificationType fora do escopo da Fase 4', async () => {
    const [evento] = await db
      .insert(eventosBrutos)
      .values({
        messageId: 'msg-2',
        notificationType: 'ENTERPRISE_UPGRADE',
        payload: { attributes: {}, data: {} },
      })
      .returning();
    if (!evento) throw new Error('setup falhou');

    const resultado = await processarEventoBruto(evento.id);
    expect(resultado.status).toBe('sem_handler');
  });

  it('grava o erro em eventos_brutos.erro quando o handler falha, e o replay pode tentar de novo', async () => {
    const [evento] = await db
      .insert(eventosBrutos)
      .values({
        messageId: 'msg-3',
        notificationType: 'STATUS_REPORT',
        payload: { attributes: {}, data: { name: 'enterprises/x/devices/nunca-existiu' } },
      })
      .returning();
    if (!evento) throw new Error('setup falhou');

    const primeiraTentativa = await processarEventoBruto(evento.id);
    expect(primeiraTentativa.status).toBe('erro');

    const [eventoAtualizado] = await db
      .select()
      .from(eventosBrutos)
      .where(eq(eventosBrutos.id, evento.id));
    expect(eventoAtualizado?.erro).toContain('nunca-existiu');
    expect(eventoAtualizado?.processadoEm).toBeNull();

    // Replay: corrige a causa raiz (aqui, simulado só re-tentando o mesmo
    // evento sem correção — continua falhando, exatamente como esperado).
    const segundaTentativa = await processarEventoBruto(evento.id);
    expect(segundaTentativa.status).toBe('erro');
  });
});
