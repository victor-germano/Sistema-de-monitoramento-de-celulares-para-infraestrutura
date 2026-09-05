import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { criadoEm, uuidPk } from './_shared.ts';
import { colaboradores } from './colaboradores.ts';
import { linhas } from './linhas.ts';
import { politicas } from './politicas.ts';

export const dispositivos = pgTable(
  'dispositivos',
  {
    id: uuidPk(),
    amapiName: text('amapi_name').notNull(),
    imei: text('imei'),
    serial: text('serial'),
    patrimonio: text('patrimonio'),
    fabricante: text('fabricante'),
    modelo: text('modelo'),
    versaoSo: text('versao_so'),
    patchSeguranca: date('patch_seguranca'),
    // `estado` e `compliance_state` espelham enums da própria AMAPI
    // (ex.: ACTIVE/DISABLED/PROVISIONING; COMPLIANT/NON_COMPLIANT/...) —
    // texto livre de propósito, não um pgEnum nosso. Travar isso num enum
    // de banco significaria toda vez que o Google adicionar um valor novo
    // do lado deles, nosso INSERT/UPDATE quebra até migrarmos o schema.
    // Enum de banco é reservado pra categorias que O NOSSO sistema origina
    // e controla (ver ADR-007) — este campo é o oposto disso: observado.
    estado: text('estado'),
    complianceState: text('compliance_state'),
    policyCompliant: boolean('policy_compliant'),
    bateriaPct: integer('bateria_pct'),
    storageTotalMb: integer('storage_total_mb'),
    storageLivreMb: integer('storage_livre_mb'),
    ultimoCheckin: timestamp('ultimo_checkin', { withTimezone: true }),
    // Coluna existe desde já; o MAPPER (Fase 4) é quem decide se preenche ou
    // descarta o valor antes do INSERT, conforme `COLETA_LOCALIZACAO_ATIVA`
    // (seção 11 — feature-flag de LGPD). A tabela não sabe da flag; o
    // mapper sim, e é ali que a decisão de descartar precisa acontecer.
    ultimaLocalizacao: jsonb('ultima_localizacao'),
    colaboradorId: uuid('colaborador_id').references(() => colaboradores.id),
    linhaId: uuid('linha_id').references(() => linhas.id),
    politicaId: uuid('politica_id').references(() => politicas.id),
    dataAquisicao: date('data_aquisicao'),
    fimGarantia: date('fim_garantia'),
    valorAquisicao: numeric('valor_aquisicao', { precision: 12, scale: 2 }),
    criadoEm: criadoEm(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dispositivos_amapi_name_idx').on(t.amapiName),
    uniqueIndex('dispositivos_patrimonio_idx').on(t.patrimonio),
    index('dispositivos_ultimo_checkin_idx').on(t.ultimoCheckin.desc()),
    index('dispositivos_colaborador_id_idx').on(t.colaboradorId),
    index('dispositivos_compliance_state_idx').on(t.complianceState),
  ],
);

export const dispositivoApps = pgTable(
  'dispositivo_apps',
  {
    id: uuidPk(),
    dispositivoId: uuid('dispositivo_id')
      .notNull()
      .references(() => dispositivos.id),
    packageName: text('package_name').notNull(),
    nomeExibicao: text('nome_exibicao'),
    versao: text('versao'),
    // Mesma lógica do `estado`/`compliance_state` de dispositivos: valores
    // observados, reportados pela AMAPI (`installType`, estado de
    // instalação) — texto livre, não enum nosso. Ver ADR-007.
    installType: text('install_type'),
    estado: text('estado'),
    coletadoEm: timestamp('coletado_em', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('dispositivo_apps_dispositivo_package_idx').on(t.dispositivoId, t.packageName),
  ],
);
