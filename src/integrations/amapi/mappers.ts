// Funções puras de tradução de formato entre o modelo interno e o shape da
// AMAPI (seção 7).
//
// ADR-002: os dois formatos de "duração" da AMAPI NÃO são intercambiáveis.
// Cada campo abaixo documenta explicitamente qual é o seu, porque presumir
// "todo campo de duração usa sufixo `s`" é exatamente o erro que já
// aconteceria com `maximumTimeToLock`.

/**
 * `Policy.maximumTimeToLock`: int64 em MILISSEGUNDOS, serializado como
 * string SEM sufixo. Ex.: 10 minutos -> `"600000"`, não `"600000ms"` nem
 * `"600s"`.
 */
export function formatarMaximumTimeToLockMs(milissegundos: number): string {
  return String(Math.trunc(milissegundos));
}

/**
 * Campos do tipo `google.protobuf.Duration` da AMAPI — ex.:
 * `PasswordRequirements.passwordExpirationTimeout`, `Command.duration`,
 * `EnrollmentToken.duration`. Formato: inteiro em SEGUNDOS + sufixo `s`.
 * Ex.: 14 dias -> `"1209600s"`.
 */
export function formatarDuracaoEmSegundos(segundos: number): string {
  return `${Math.trunc(segundos)}s`;
}

// --- Device (AMAPI) -> dispositivos/dispositivo_apps (interno) -------------
// ADR-019: campos onde o `Schema$Device` do `googleapis` NÃO bate 1:1 com a
// tabela `dispositivos` da seção 6, e a decisão tomada pra cada um.
import type { androidmanagement_v1 } from 'googleapis';

type Device = androidmanagement_v1.Schema$Device;
type ApplicationReport = androidmanagement_v1.Schema$ApplicationReport;

function bytesParaMb(valor: string | null | undefined): number | undefined {
  if (!valor) return undefined;
  const bytes = Number(valor);
  return Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : undefined;
}

/**
 * A AMAPI não tem um campo "compliance_state" (string) no `Device` — só
 * `policyCompliant` (boolean) e `nonComplianceDetails` (lista de motivos).
 * A seção 6 pede as duas colunas (`estado` E `compliance_state`) separadas
 * de `policy_compliant`; deriva-se um rótulo textual a partir do booleano
 * pra preencher a coluna sem inventar um enum que a AMAPI não tem. `null`
 * quando o device ainda não reportou compliance nenhuma vez (nem
 * conforme, nem não-conforme — desconhecido).
 */
function derivarComplianceState(policyCompliant: boolean | null | undefined): string | undefined {
  if (policyCompliant === true) return 'COMPLIANT';
  if (policyCompliant === false) return 'NON_COMPLIANT';
  return undefined;
}

/**
 * Bateria e storage "livres" não são campos estáticos no `Device` — são o
 * evento MAIS RECENTE de `powerManagementEvents`/`memoryEvents` (listas de
 * eventos ao longo do tempo). A AMAPI não documenta publicamente (no
 * conteúdo que consegui conferir) os valores exatos do enum de
 * `MemoryEvent.eventType` — o filtro abaixo por "contém STORAGE" é
 * propositalmente tolerante em vez de comparar contra um literal que eu
 * não consegui confirmar. **Validar contra um device real assim que
 * possível** (bloqueado hoje pela enterprise placeholder, ADR-005); até lá
 * os alertas que dependem disso (STORAGE_CRITICO/BATERIA_DEGRADADA, Fase 6)
 * herdam essa incerteza.
 */
type PowerManagementEvent = androidmanagement_v1.Schema$PowerManagementEvent;
type MemoryEvent = androidmanagement_v1.Schema$MemoryEvent;

// Predicado com type guard (`e is ... & { createTime: string }`) em vez de
// um filtro que retorna `boolean` puro: o objetivo não é só filtrar, é
// ELIMINAR o `string | null | undefined` de `createTime` pro `.sort()`
// seguinte comparar direto, sem precisar de um `?? ''` de fallback pra um
// caso que o filtro anterior já tornou impossível (branch morta, nunca
// exercitada — 100% de cobertura de branch em `mappers.ts` é exigência da
// spec, seção 14).
function temBateriaEHorario(
  evento: PowerManagementEvent,
): evento is PowerManagementEvent & { batteryLevel: number; createTime: string } {
  return typeof evento.batteryLevel === 'number' && Boolean(evento.createTime);
}

function extrairUltimaBateriaPct(device: Device): number | undefined {
  const maisRecente = (device.powerManagementEvents ?? [])
    .filter(temBateriaEHorario)
    .sort((a, b) => b.createTime.localeCompare(a.createTime))[0];
  return maisRecente?.batteryLevel;
}

function ehEventoDeStorageComHorario(
  evento: MemoryEvent,
): evento is MemoryEvent & { createTime: string } {
  return Boolean(evento.eventType?.toUpperCase().includes('STORAGE')) && Boolean(evento.createTime);
}

function extrairStorageLivreMb(device: Device): number | undefined {
  const maisRecente = (device.memoryEvents ?? [])
    .filter(ehEventoDeStorageComHorario)
    .sort((a, b) => b.createTime.localeCompare(a.createTime))[0];
  return bytesParaMb(maisRecente?.byteCount);
}

export interface CamposDispositivoDeStatusReport {
  imei?: string;
  serial?: string;
  fabricante?: string;
  modelo?: string;
  versaoSo?: string;
  patchSeguranca?: string;
  estado?: string;
  complianceState?: string;
  policyCompliant?: boolean;
  bateriaPct?: number;
  storageTotalMb?: number;
  storageLivreMb?: number;
  ultimoCheckin?: Date;
}

/** Usado pelo handler `STATUS_REPORT` (seção 8, Fase 4) pra montar o `UPDATE` de `dispositivos`. */
export function mapearCamposDispositivo(device: Device): CamposDispositivoDeStatusReport {
  return {
    imei: device.networkInfo?.imei ?? undefined,
    serial: device.hardwareInfo?.serialNumber ?? undefined,
    fabricante: device.hardwareInfo?.manufacturer ?? undefined,
    modelo: device.hardwareInfo?.model ?? undefined,
    versaoSo: device.softwareInfo?.androidVersion ?? undefined,
    patchSeguranca: device.softwareInfo?.securityPatchLevel ?? undefined,
    estado: device.state ?? undefined,
    complianceState: derivarComplianceState(device.policyCompliant),
    policyCompliant: device.policyCompliant ?? undefined,
    bateriaPct: extrairUltimaBateriaPct(device),
    storageTotalMb: bytesParaMb(device.memoryInfo?.totalInternalStorage),
    storageLivreMb: extrairStorageLivreMb(device),
    ultimoCheckin: device.lastStatusReportTime ? new Date(device.lastStatusReportTime) : undefined,
  };
}

export interface CampoDispositivoApp {
  packageName: string;
  nomeExibicao?: string;
  versao?: string;
  estado?: string;
  coletadoEm: Date;
}

/**
 * `ApplicationReport` não tem um campo "installType" — isso é um conceito
 * de POLÍTICA (o que QUEREMOS instalado), não do relatório do device (o
 * que ESTÁ instalado). `dispositivo_apps.install_type` fica sem valor
 * quando populado a partir do `STATUS_REPORT` — não inventamos um valor
 * que a AMAPI não relata. O alerta `APP_OBRIGATORIO_AUSENTE` compara contra
 * a política diretamente (por `packageName`), não contra esta coluna.
 */
export function mapearAppsDoDispositivo(
  relatorios: readonly ApplicationReport[],
  coletadoEm: Date,
): CampoDispositivoApp[] {
  return relatorios
    .filter((relatorio): relatorio is ApplicationReport & { packageName: string } =>
      Boolean(relatorio.packageName),
    )
    .map((relatorio) => ({
      packageName: relatorio.packageName,
      nomeExibicao: relatorio.displayName ?? undefined,
      versao: relatorio.versionName ?? undefined,
      estado: relatorio.state ?? undefined,
      coletadoEm,
    }));
}
