import type { androidmanagement_v1 } from 'googleapis';
import { db, sql } from '../client.ts';
import { politicas } from '../schema/politicas.ts';
import { enforceInvariants } from '../../domain/policy/policy-invariants.ts';
import { formatarMaximumTimeToLockMs } from '../../integrations/amapi/mappers.ts';
import { logger } from '../../shared/logger.ts';

type PolicyPayload = androidmanagement_v1.Schema$Policy;

// Seção 7: as duas políticas padrão cobrem os mesmos campos de segurança —
// a spec não diferencia os VALORES entre "administrativo" e
// "operacao-campo", só os nomes/propósito. `maximumTimeToLock` (1 minuto)
// é uma decisão nossa, não pedida explicitamente pela spec — documentada
// em docs/DECISOES.md (ADR-016), ajustável depois via `PATCH /policies/:id`
// (Fase 5) sem precisar mexer neste seed de novo.
const BASE_PADRAO: PolicyPayload = {
  passwordPolicies: [
    {
      passwordQuality: 'NUMERIC_COMPLEX',
      passwordMinimumLength: 6,
      maximumFailedPasswordsForWipe: 10,
    },
  ],
  maximumTimeToLock: formatarMaximumTimeToLockMs(60_000),
  factoryResetDisabled: true,
  addUserDisabled: true,
  mountPhysicalMediaDisabled: true,
  installUnknownSourcesAllowed: false,
  statusReportingSettings: {
    applicationReportsEnabled: true,
    commonCriteriaModeEnabled: true,
    defaultApplicationInfoReportingEnabled: true,
    deviceSettingsEnabled: true,
    displayInfoEnabled: true,
    hardwareStatusEnabled: true,
    memoryInfoEnabled: true,
    networkInfoEnabled: true,
    powerManagementEventsEnabled: true,
    softwareInfoEnabled: true,
    systemPropertiesEnabled: true,
  },
  // 02:00–05:00 local do device, seção 7. Minutos após meia-noite: 2h = 120, 5h = 300.
  systemUpdate: { type: 'WINDOWED', startMinutes: 120, endMinutes: 300 },
  // Lista de apps de cada perfil é decisão de negócio (quais apps cada
  // função usa) que ninguém definiu ainda — ver docs/DECISOES.md (ADR-016).
  // Vazia aqui não quebra `enforceInvariants` (não há item pra validar) e
  // fica pronta pra ser preenchida via `PATCH /policies/:id` na Fase 5.
  applications: [],
};

interface PoliticaSeed {
  nome: string;
  descricao: string;
}

const POLITICAS_SEED: PoliticaSeed[] = [
  {
    nome: 'administrativo',
    descricao: 'Perfil padrão para colaboradores administrativos (escritório/filiais).',
  },
  {
    nome: 'operacao-campo',
    descricao: 'Perfil padrão para equipes operacionais em campo.',
  },
];

/**
 * Idempotente: se a política já existe (por `nome`, unique), não duplica —
 * só avisa e segue. Roda só contra o NOSSO banco; não empurra pra AMAPI
 * ainda (sem enterprise real configurada — ADR-005). O envio de verdade
 * acontece via `salvarPolitica` (Fase 5), quando alguém editar/ativar essa
 * política pela rota.
 */
export async function seedPoliticasPadrao(): Promise<void> {
  for (const { nome, descricao } of POLITICAS_SEED) {
    const jaExiste = await db.query.politicas.findFirst({ where: (p, { eq }) => eq(p.nome, nome) });
    if (jaExiste) {
      logger.info({ nome }, 'política padrão já existe, seed ignorado pra ela');
      continue;
    }

    const payload = enforceInvariants({ ...BASE_PADRAO });
    await db.insert(politicas).values({ nome, descricao, payload, versao: 1, ativa: true });
    logger.info({ nome }, 'política padrão semeada');
  }
}

// Permite `tsx src/db/seed/politicas-padrao.ts` direto (`npm run db:seed`),
// sem exigir um runner de teste ou um endpoint HTTP só pra popular o banco.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedPoliticasPadrao()
    .then(() => sql.end())
    .catch((erro: unknown) => {
      logger.error({ err: erro }, 'falha ao semear políticas padrão');
      process.exitCode = 1;
    });
}
