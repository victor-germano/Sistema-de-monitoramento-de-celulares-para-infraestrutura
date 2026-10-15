// Handler do `notificationType: 'ENROLLMENT'` (seção 8, Fase 4) — critério
// de aceite explícito da fase: "enrollment de device de teste popula o
// banco com o vínculo correto, sozinho".
import { and, eq, isNull } from 'drizzle-orm';
import type { androidmanagement_v1 } from 'googleapis';
import type { db } from '../../../db/client.ts';
import { enrollmentTokens } from '../../../db/schema/enrollment-tokens.ts';
import { criarDispositivo, buscarDispositivoPorAmapiName } from '../../dispositivos/repositorio.ts';
import { logger } from '../../../shared/logger.ts';
import type { AdditionalDataEnrollment } from '../../../integrations/amapi/enrollment.ts';

type Device = androidmanagement_v1.Schema$Device;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class EnrollmentTokenInvalidoError extends Error {
  constructor(motivo: string) {
    super(`ENROLLMENT: ${motivo}`);
    this.name = 'EnrollmentTokenInvalidoError';
  }
}

/**
 * `device.enrollmentTokenData` é EXATAMENTE a string `additionalData` que
 * `criarEnrollmentToken` (seção 7) gravou na criação do token — não um
 * wrapper, não um subconjunto (ADR-017). Parseá-la de volta pro JSON
 * original é a única forma de correlacionar o device recém-provisionado
 * com a linha de `enrollment_tokens` (e, por tabela, com o colaborador/
 * patrimônio) sem depender de nenhuma janela de tempo entre criação do
 * token e o evento chegar.
 */
function parsearAdditionalData(raw: string | null | undefined): AdditionalDataEnrollment {
  if (!raw) {
    throw new EnrollmentTokenInvalidoError(
      'device sem enrollmentTokenData — token não veio da nossa criação',
    );
  }
  let dados: unknown;
  try {
    dados = JSON.parse(raw);
  } catch {
    throw new EnrollmentTokenInvalidoError('enrollmentTokenData não é JSON válido');
  }
  if (
    typeof dados !== 'object' ||
    dados === null ||
    typeof (dados as { tokenId?: unknown }).tokenId !== 'string'
  ) {
    throw new EnrollmentTokenInvalidoError(
      'enrollmentTokenData sem tokenId — não foi criado por este sistema',
    );
  }
  return dados as AdditionalDataEnrollment;
}

/**
 * Roda dentro da transação da mensagem (o `pubsub-consumer` abre o `tx` e
 * chama isto) — se qualquer passo falhar, nem o dispositivo nem a marcação
 * do token como usado ficam gravados, e a mensagem é reprocessada (nack).
 *
 * Idempotência: se o device já existe (`amapi_name` já cadastrado — caso
 * de redelivery do Pub/Sub, at-least-once), não recria nada; só loga e
 * retorna a linha existente.
 */
export async function processarEnrollment(tx: Tx, device: Device): Promise<void> {
  if (!device.name) {
    throw new EnrollmentTokenInvalidoError('device sem `name` — resposta da AMAPI incompleta');
  }

  const existente = await buscarDispositivoPorAmapiName(tx, device.name);
  if (existente) {
    logger.info(
      { amapiName: device.name },
      'ENROLLMENT: device já cadastrado, ignorando (redelivery)',
    );
    return;
  }

  const additionalData = parsearAdditionalData(device.enrollmentTokenData);

  // Achado numa revisão: SELECT + checar `usadoEm` + UPDATE depois é
  // check-then-act, não atômico — duas mensagens ENROLLMENT concorrentes
  // pro MESMO token (ex.: redelivery sobrepondo o processamento original)
  // podiam ambas passar pelo SELECT antes de qualquer UPDATE comitar, e as
  // duas criarem um dispositivo cada. `oneTimeOnly: true` (seção 7) já
  // impede isso do lado da AMAPI — isto aqui segue sendo defesa em
  // profundidade, mas agora de verdade atômica: o UPDATE com `WHERE
  // usado_em IS NULL` só afeta uma linha quando a reivindicação é a
  // PRIMEIRA — sob o lock de linha do Postgres, uma segunda tentativa
  // concorrente reavalia a condição depois que a primeira comita e não
  // encontra mais `usado_em IS NULL`, então não afeta nenhuma linha.
  const [tokenReclamado] = await tx
    .update(enrollmentTokens)
    .set({ usadoEm: new Date() })
    .where(and(eq(enrollmentTokens.id, additionalData.tokenId), isNull(enrollmentTokens.usadoEm)))
    .returning();

  if (!tokenReclamado) {
    const [tokenExistente] = await tx
      .select()
      .from(enrollmentTokens)
      .where(eq(enrollmentTokens.id, additionalData.tokenId))
      .limit(1);
    if (!tokenExistente) {
      throw new EnrollmentTokenInvalidoError(
        `tokenId ${additionalData.tokenId} não encontrado em enrollment_tokens`,
      );
    }
    throw new EnrollmentTokenInvalidoError(`token ${tokenExistente.id} já foi marcado como usado`);
  }

  const dispositivo = await criarDispositivo(tx, {
    amapiName: device.name,
    imei: device.networkInfo?.imei ?? undefined,
    serial: device.hardwareInfo?.serialNumber ?? undefined,
    fabricante: device.hardwareInfo?.manufacturer ?? undefined,
    modelo: device.hardwareInfo?.model ?? undefined,
    versaoSo: device.softwareInfo?.androidVersion ?? undefined,
    estado: device.state ?? undefined,
    // Patrimônio/colaborador: prioriza o que já veio no `additionalData` no
    // momento da criação do token; cai pro que está gravado na própria
    // linha de `enrollment_tokens` quando o token foi criado sem esses
    // dados (ex.: token genérico de estoque, vinculado depois via
    // `PATCH /devices/:id`).
    patrimonio: additionalData.patrimonio ?? tokenReclamado.patrimonio ?? undefined,
    colaboradorId: additionalData.colaboradorId ?? tokenReclamado.colaboradorId ?? undefined,
    politicaId: tokenReclamado.politicaId ?? undefined,
  });

  await tx
    .update(enrollmentTokens)
    .set({ dispositivoId: dispositivo.id })
    .where(eq(enrollmentTokens.id, tokenReclamado.id));

  logger.info(
    { dispositivoId: dispositivo.id, amapiName: device.name, tokenId: tokenReclamado.id },
    'ENROLLMENT: dispositivo provisionado e vinculado',
  );
}
