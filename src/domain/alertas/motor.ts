// Motor de alertas (seção 9, Fase 6) — os 9 tipos se dividem em dois
// mecanismos bem diferentes:
//
// - REATIVO (5 tipos): checados a cada `STATUS_REPORT` processado, porque a
//   condição só pode ser avaliada com o dado que acabou de chegar
//   (compliance, patch, versão do SO, storage, bateria). Chamado de dentro
//   de `src/domain/eventos/handlers/status-report.ts`, na mesma transação.
// - PERIÓDICO (3 tipos): SEM_CHECKIN, DISPOSITIVO_ORFAO e LINHA_SEM_USO são
//   sobre AUSÊNCIA de algo — nenhum evento reativo detecta sozinho "esse
//   dispositivo não manda STATUS_REPORT há 3 dias" ou "esta linha nunca foi
//   vinculada a um device". Precisam de um scan periódico contra a frota
//   inteira — `src/workers/manutencao-worker.ts`.
//
// `APP_OBRIGATORIO_AUSENTE` (o 9º tipo) já foi implementado na Fase 4,
// dentro do próprio `status-report.ts` — não duplicado aqui.
import { and, eq, isNull, lt } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { dispositivos } from '../../db/schema/dispositivos.ts';
import { linhas } from '../../db/schema/linhas.ts';
import { alertas } from '../../db/schema/alertas.ts';
import { env } from '../../config/env.ts';
import type { Dispositivo } from '../dispositivos/repositorio.ts';
import {
  abrirAlertaSeNaoExistir,
  resolverAlertaDeLinhaSeAberto,
  resolverAlertaSeAberto,
  type TipoAlerta,
} from './repositorio.ts';

type Executor = Pick<typeof db, 'insert' | 'update' | 'select'>;

function diasEntre(data: Date, referencia: Date): number {
  return (referencia.getTime() - data.getTime()) / (24 * 60 * 60 * 1000);
}

// --- Verificações REATIVAS (chamadas por STATUS_REPORT) ---------------------

async function verificarNaoConforme(executor: Executor, dispositivo: Dispositivo): Promise<void> {
  if (dispositivo.complianceState === 'NON_COMPLIANT') {
    await abrirAlertaSeNaoExistir(executor, {
      dispositivoId: dispositivo.id,
      tipo: 'NAO_CONFORME',
      severidade: 'ALTA',
      titulo: 'Dispositivo fora de conformidade com a política',
    });
  } else {
    await resolverAlertaSeAberto(executor, dispositivo.id, 'NAO_CONFORME');
  }
}

async function verificarPatchDesatualizado(
  executor: Executor,
  dispositivo: Dispositivo,
): Promise<void> {
  // Sem dado ainda (device recém-enrollado, primeiro STATUS_REPORT não
  // chegou) — não afirma nada, nem abre nem fecha.
  if (!dispositivo.patchSeguranca) return;

  const idadeDias = diasEntre(new Date(dispositivo.patchSeguranca), new Date());
  if (idadeDias > env.ALERTA_PATCH_MAX_DIAS) {
    await abrirAlertaSeNaoExistir(executor, {
      dispositivoId: dispositivo.id,
      tipo: 'PATCH_DESATUALIZADO',
      severidade: 'MEDIA',
      titulo: `Patch de segurança com mais de ${env.ALERTA_PATCH_MAX_DIAS} dias`,
      detalhes: {
        patchSeguranca: dispositivo.patchSeguranca,
        limiteDias: env.ALERTA_PATCH_MAX_DIAS,
      },
    });
  } else {
    await resolverAlertaSeAberto(executor, dispositivo.id, 'PATCH_DESATUALIZADO');
  }
}

// Nível de API (SDK) -> versão "major" do Android — a AMAPI não expõe o
// nível de API diretamente (`SoftwareInfo` só tem `androidVersion`, a
// versão "visível ao usuário", ex.: "13", "6.0.1"). Cobre só os níveis que
// enterprises Android Management suporta oficialmente (API 21+). ADR-030.
const SDK_PARA_VERSAO_MAJOR: Readonly<Record<number, number>> = {
  21: 5,
  22: 5,
  23: 6,
  24: 7,
  25: 7,
  26: 8,
  27: 8,
  28: 9,
  29: 10,
  30: 11,
  31: 12,
  32: 12,
  33: 13,
  34: 14,
  35: 15,
};

function versaoMajorMinimaAceita(): number {
  // SDK fora da tabela (config inválida) -> 0 nunca marca ninguém como
  // obsoleto, em vez de um falso-positivo em massa por um número errado.
  return SDK_PARA_VERSAO_MAJOR[env.ANDROID_VERSAO_MINIMA_SDK] ?? 0;
}

function versaoMajorDoDispositivo(versaoSo: string): number | undefined {
  const casado = /^(\d+)/.exec(versaoSo);
  return casado ? Number(casado[1]) : undefined;
}

async function verificarSoObsoleto(executor: Executor, dispositivo: Dispositivo): Promise<void> {
  const major = dispositivo.versaoSo ? versaoMajorDoDispositivo(dispositivo.versaoSo) : undefined;
  if (major === undefined) return;

  if (major < versaoMajorMinimaAceita()) {
    await abrirAlertaSeNaoExistir(executor, {
      dispositivoId: dispositivo.id,
      tipo: 'SO_OBSOLETO',
      severidade: 'MEDIA',
      titulo: `Android ${dispositivo.versaoSo} abaixo do mínimo aceito`,
      detalhes: { versaoSo: dispositivo.versaoSo, sdkMinimo: env.ANDROID_VERSAO_MINIMA_SDK },
    });
  } else {
    await resolverAlertaSeAberto(executor, dispositivo.id, 'SO_OBSOLETO');
  }
}

async function verificarStorageCritico(
  executor: Executor,
  dispositivo: Dispositivo,
): Promise<void> {
  if (dispositivo.storageLivreMb === null) return;

  if (dispositivo.storageLivreMb < env.ALERTA_STORAGE_CRITICO_MB) {
    await abrirAlertaSeNaoExistir(executor, {
      dispositivoId: dispositivo.id,
      tipo: 'STORAGE_CRITICO',
      severidade: 'ALTA',
      titulo: `Storage livre abaixo de ${env.ALERTA_STORAGE_CRITICO_MB}MB`,
      detalhes: { storageLivreMb: dispositivo.storageLivreMb },
    });
  } else {
    await resolverAlertaSeAberto(executor, dispositivo.id, 'STORAGE_CRITICO');
  }
}

/**
 * ATENÇÃO nomenclatura (ADR-029): a AMAPI não relata "degradação"/saúde de
 * bateria — `Schema$PowerManagementEvent` só tem `batteryLevel`, um
 * percentual de CARGA atual, não um indicador de desgaste físico da
 * bateria (não existe campo de battery health/wear neste schema).
 * Interpretação adotada: "bateria criticamente baixa no último check-in" —
 * o proxy mensurável mais próximo do nome do alerta, não uma medição real
 * de degradação. Ajustável via `ALERTA_BATERIA_CRITICA_PCT` se a
 * interpretação divergir do que o Victor tinha em mente.
 */
async function verificarBateriaDegradada(
  executor: Executor,
  dispositivo: Dispositivo,
): Promise<void> {
  if (dispositivo.bateriaPct === null) return;

  if (dispositivo.bateriaPct < env.ALERTA_BATERIA_CRITICA_PCT) {
    await abrirAlertaSeNaoExistir(executor, {
      dispositivoId: dispositivo.id,
      tipo: 'BATERIA_DEGRADADA',
      severidade: 'BAIXA',
      titulo: `Bateria em ${dispositivo.bateriaPct}% no último check-in`,
      detalhes: { bateriaPct: dispositivo.bateriaPct },
    });
  } else {
    await resolverAlertaSeAberto(executor, dispositivo.id, 'BATERIA_DEGRADADA');
  }
}

/** Chamado por `processarStatusReport` — os 5 tipos reativos, um dispositivo por vez. */
export async function verificarAlertasReativos(
  executor: Executor,
  dispositivo: Dispositivo,
): Promise<void> {
  await verificarNaoConforme(executor, dispositivo);
  await verificarPatchDesatualizado(executor, dispositivo);
  await verificarSoObsoleto(executor, dispositivo);
  await verificarStorageCritico(executor, dispositivo);
  await verificarBateriaDegradada(executor, dispositivo);
}

// --- Verificações PERIÓDICAS (scan da frota inteira) ------------------------

export interface ResultadoScan {
  candidatos: number;
  abertos: number;
  resolvidos: number;
}

/** Dispositivos ativos sem check-in há mais de `ALERTA_SEM_CHECKIN_DIAS`. */
export async function verificarDispositivosSemCheckin(): Promise<ResultadoScan> {
  const limite = new Date(Date.now() - env.ALERTA_SEM_CHECKIN_DIAS * 24 * 60 * 60 * 1000);

  const candidatos = await db
    .select({ id: dispositivos.id, ultimoCheckin: dispositivos.ultimoCheckin })
    .from(dispositivos)
    .where(
      and(eq(dispositivos.ativo, true), lt(dispositivos.ultimoCheckin, limite)),
      // `ultimoCheckin` nulo (nunca reportou) também conta — tratado abaixo.
    );

  const nuncaReportaram = await db
    .select({ id: dispositivos.id })
    .from(dispositivos)
    .where(and(eq(dispositivos.ativo, true), isNull(dispositivos.ultimoCheckin)));

  const idsCandidatos = new Set([
    ...candidatos.map((d) => d.id),
    ...nuncaReportaram.map((d) => d.id),
  ]);

  let abertos = 0;
  for (const id of idsCandidatos) {
    const candidato = candidatos.find((d) => d.id === id);
    const alerta = await abrirAlertaSeNaoExistir(db, {
      dispositivoId: id,
      tipo: 'SEM_CHECKIN',
      severidade: 'MEDIA',
      titulo: `Sem check-in há mais de ${env.ALERTA_SEM_CHECKIN_DIAS} dias`,
      detalhes: { ultimoCheckin: candidato?.ultimoCheckin ?? null },
    });
    if (alerta) abertos += 1;
  }

  const resolvidos = await sincronizarResolucoes('SEM_CHECKIN', idsCandidatos);
  return { candidatos: idsCandidatos.size, abertos, resolvidos };
}

/** Dispositivos ativos sem colaborador vinculado há mais de `ALERTA_DISPOSITIVO_ORFAO_DIAS`. */
export async function verificarDispositivosOrfaos(): Promise<ResultadoScan> {
  const limite = new Date(Date.now() - env.ALERTA_DISPOSITIVO_ORFAO_DIAS * 24 * 60 * 60 * 1000);

  const candidatos = await db
    .select({ id: dispositivos.id })
    .from(dispositivos)
    .where(
      and(
        eq(dispositivos.ativo, true),
        isNull(dispositivos.colaboradorId),
        lt(dispositivos.criadoEm, limite),
      ),
    );

  const idsCandidatos = new Set(candidatos.map((d) => d.id));

  let abertos = 0;
  for (const id of idsCandidatos) {
    const alerta = await abrirAlertaSeNaoExistir(db, {
      dispositivoId: id,
      tipo: 'DISPOSITIVO_ORFAO',
      severidade: 'BAIXA',
      titulo: `Sem colaborador vinculado há mais de ${env.ALERTA_DISPOSITIVO_ORFAO_DIAS} dias`,
    });
    if (alerta) abertos += 1;
  }

  const resolvidos = await sincronizarResolucoes('DISPOSITIVO_ORFAO', idsCandidatos);
  return { candidatos: idsCandidatos.size, abertos, resolvidos };
}

/** Linhas ativas sem nenhum dispositivo apontando pra elas — custo sem uso. */
export async function verificarLinhasSemUso(): Promise<ResultadoScan> {
  const linhasComDispositivo = await db
    .select({ linhaId: dispositivos.linhaId })
    .from(dispositivos)
    .where(eq(dispositivos.ativo, true));
  const idsComDispositivo = new Set(
    linhasComDispositivo.map((d) => d.linhaId).filter((id): id is string => id !== null),
  );

  const linhasAtivas = await db
    .select({ id: linhas.id })
    .from(linhas)
    .where(eq(linhas.status, 'ativa'));
  const idsCandidatos = new Set(
    linhasAtivas.map((l) => l.id).filter((id) => !idsComDispositivo.has(id)),
  );

  let abertos = 0;
  for (const id of idsCandidatos) {
    const alerta = await abrirAlertaSeNaoExistir(db, {
      linhaId: id,
      tipo: 'LINHA_SEM_USO',
      severidade: 'BAIXA',
      titulo: 'Linha ativa sem dispositivo vinculado',
    });
    if (alerta) abertos += 1;
  }

  let resolvidos = 0;
  const abertosAtuais = await db
    .select({ linhaId: alertas.linhaId })
    .from(alertas)
    .where(and(eq(alertas.tipo, 'LINHA_SEM_USO'), isNull(alertas.resolvidoEm)));
  for (const { linhaId } of abertosAtuais) {
    if (linhaId && !idsCandidatos.has(linhaId)) {
      await resolverAlertaDeLinhaSeAberto(db, linhaId, 'LINHA_SEM_USO');
      resolvidos += 1;
    }
  }

  return { candidatos: idsCandidatos.size, abertos, resolvidos };
}

/**
 * Fecha os alertas abertos de `tipo` cujo dispositivo não está mais no
 * conjunto de candidatos desta rodada de scan — é o que faz um alerta
 * periódico se "auto-curar" (ex.: dispositivo voltou a dar check-in).
 */
async function sincronizarResolucoes(
  tipo: TipoAlerta,
  idsCandidatos: Set<string>,
): Promise<number> {
  const abertosAtuais = await db
    .select({ dispositivoId: alertas.dispositivoId })
    .from(alertas)
    .where(and(eq(alertas.tipo, tipo), isNull(alertas.resolvidoEm)));

  let resolvidos = 0;
  for (const { dispositivoId } of abertosAtuais) {
    if (dispositivoId && !idsCandidatos.has(dispositivoId)) {
      await resolverAlertaSeAberto(db, dispositivoId, tipo);
      resolvidos += 1;
    }
  }
  return resolvidos;
}

/** Roda os 3 scans periódicos em sequência — usado pelo worker e pelo endpoint manual. */
export async function executarScanPeriodico(): Promise<{
  semCheckin: ResultadoScan;
  dispositivosOrfaos: ResultadoScan;
  linhasSemUso: ResultadoScan;
}> {
  return {
    semCheckin: await verificarDispositivosSemCheckin(),
    dispositivosOrfaos: await verificarDispositivosOrfaos(),
    linhasSemUso: await verificarLinhasSemUso(),
  };
}
