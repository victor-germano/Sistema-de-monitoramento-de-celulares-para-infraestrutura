// Handler do `notificationType: 'STATUS_REPORT'` (seção 8) — device já
// provisionado reportando estado atual. Ao contrário do ENROLLMENT, não cria
// nada: só atualiza o que já existe e roda os 6 alertas "reativos" que só
// fazem sentido com o dado que acabou de chegar — `APP_OBRIGATORIO_AUSENTE`
// (Fase 4) e os 5 do motor de alertas (Fase 6, `src/domain/alertas/motor.ts`;
// os outros 3 tipos da seção 9 são scan periódico, não reativo).
import { eq } from 'drizzle-orm';
import type { androidmanagement_v1 } from 'googleapis';
import type { db } from '../../../db/client.ts';
import { politicas } from '../../../db/schema/politicas.ts';
import {
  atualizarDispositivoPorAmapiName,
  upsertDispositivoApps,
  listarAppsDoDispositivo,
} from '../../dispositivos/repositorio.ts';
import { abrirAlertaSeNaoExistir, resolverAlertaSeAberto } from '../../alertas/repositorio.ts';
import { verificarAlertasReativos } from '../../alertas/motor.ts';
import {
  mapearCamposDispositivo,
  mapearAppsDoDispositivo,
} from '../../../integrations/amapi/mappers.ts';
import type { AppPolicy } from '../../policy/policy-invariants.ts';
import { logger } from '../../../shared/logger.ts';

type Device = androidmanagement_v1.Schema$Device;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class DispositivoDesconhecidoError extends Error {
  constructor(amapiName: string) {
    super(
      `STATUS_REPORT: dispositivo ${amapiName} não encontrado — provavelmente ENROLLMENT ainda não processado`,
    );
    this.name = 'DispositivoDesconhecidoError';
  }
}

/**
 * Compara os `packageName` com `installType === 'FORCE_INSTALLED'` na
 * política contra o que o `STATUS_REPORT` reportou de fato instalado.
 * Lê `politicas.payload` (a versão ATIVA já cacheada no nosso banco), não
 * chama a AMAPI ao vivo — evita uma chamada de rede síncrona por mensagem
 * processada, e o payload local é sempre o que foi efetivamente aplicado
 * via `salvarPolitica` (seção 7).
 */
function extrairPackagesObrigatorios(payload: unknown): string[] {
  const applications = (payload as { applications?: AppPolicy[] } | null)?.applications ?? [];
  return applications
    .filter((app) => app.installType === 'FORCE_INSTALLED' && Boolean(app.packageName))
    .map((app) => app.packageName as string);
}

/**
 * Mesmo contrato de `processarEnrollment`: roda dentro da transação da
 * mensagem, aberta pelo `pubsub-consumer`.
 *
 * Idempotência: `atualizarDispositivoPorAmapiName`/`upsertDispositivoApps`
 * são UPDATE/upsert puros — reprocessar o mesmo `STATUS_REPORT` (redelivery)
 * produz o mesmo estado final, sem duplicar nada. `abrirAlertaSeNaoExistir`
 * é idempotente por construção (ADR-020).
 */
export async function processarStatusReport(tx: Tx, device: Device): Promise<void> {
  if (!device.name) {
    throw new DispositivoDesconhecidoError('(sem name)');
  }

  const coletadoEm = new Date();
  const campos = mapearCamposDispositivo(device);

  const dispositivo = await atualizarDispositivoPorAmapiName(tx, device.name, {
    imei: campos.imei,
    serial: campos.serial,
    fabricante: campos.fabricante,
    modelo: campos.modelo,
    versaoSo: campos.versaoSo,
    patchSeguranca: campos.patchSeguranca,
    estado: campos.estado,
    complianceState: campos.complianceState,
    policyCompliant: campos.policyCompliant,
    bateriaPct: campos.bateriaPct,
    storageTotalMb: campos.storageTotalMb,
    storageLivreMb: campos.storageLivreMb,
    ultimoCheckin: campos.ultimoCheckin ?? coletadoEm,
  });

  if (!dispositivo) {
    throw new DispositivoDesconhecidoError(device.name);
  }

  const appsReportados = mapearAppsDoDispositivo(device.applicationReports ?? [], coletadoEm);
  await upsertDispositivoApps(tx, dispositivo.id, appsReportados);

  // Sempre chamado, mesmo sem política vinculada (`politicaId: null`) — ver
  // comentário dentro da função: precisa resolver um alerta aberto quando o
  // device foi desvinculado, não só quando ele continua vinculado mas sem
  // apps obrigatórios.
  await verificarAppsObrigatorios(tx, dispositivo.id, dispositivo.politicaId);

  await verificarAlertasReativos(tx, dispositivo);

  logger.info(
    { dispositivoId: dispositivo.id, amapiName: device.name, apps: appsReportados.length },
    'STATUS_REPORT: dispositivo atualizado',
  );
}

/**
 * Achado numa revisão: as duas saídas antecipadas abaixo (`!politica` e
 * `obrigatorios.length === 0`) retornavam sem nunca chegar no
 * `resolverAlertaSeAberto` — diferente de todo outro alerta reativo, este
 * não tinha caminho de resolução simétrico. Um device desvinculado da
 * política (`politicaId: null`, pego pelo chamador) ou cuja política parou
 * de exigir qualquer app `FORCE_INSTALLED` ficava com `APP_OBRIGATORIO_
 * AUSENTE` aberto pra sempre, mesmo sem motivo nenhum pra isso.
 */
async function verificarAppsObrigatorios(
  tx: Tx,
  dispositivoId: string,
  politicaId: string | null,
): Promise<void> {
  if (!politicaId) {
    await resolverAlertaSeAberto(tx, dispositivoId, 'APP_OBRIGATORIO_AUSENTE');
    return;
  }

  const [politica] = await tx.select().from(politicas).where(eq(politicas.id, politicaId)).limit(1);
  if (!politica) {
    await resolverAlertaSeAberto(tx, dispositivoId, 'APP_OBRIGATORIO_AUSENTE');
    return;
  }

  const obrigatorios = extrairPackagesObrigatorios(politica.payload);
  if (obrigatorios.length === 0) {
    await resolverAlertaSeAberto(tx, dispositivoId, 'APP_OBRIGATORIO_AUSENTE');
    return;
  }

  const instalados = new Set(
    (await listarAppsDoDispositivo(tx, dispositivoId)).map((app) => app.packageName),
  );
  const ausentes = obrigatorios.filter((pkg) => !instalados.has(pkg));

  if (ausentes.length === 0) {
    await resolverAlertaSeAberto(tx, dispositivoId, 'APP_OBRIGATORIO_AUSENTE');
    return;
  }

  await abrirAlertaSeNaoExistir(tx, {
    dispositivoId,
    tipo: 'APP_OBRIGATORIO_AUSENTE',
    severidade: 'MEDIA',
    titulo: `${ausentes.length} app(s) obrigatório(s) ausente(s)`,
    detalhes: { packages: ausentes },
  });
}
