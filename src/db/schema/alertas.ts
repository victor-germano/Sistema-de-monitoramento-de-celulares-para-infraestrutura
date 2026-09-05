import { sql } from 'drizzle-orm';
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { criadoEm, uuidPk } from './_shared.ts';
import { dispositivos } from './dispositivos.ts';

// Os 9 tipos da seção 9 — fechado e controlado pelo motor de alertas (nosso
// código), não observado de fora. Enum de banco, ver ADR-007.
export const alertaTipoEnum = pgEnum('alerta_tipo', [
  'SEM_CHECKIN',
  'NAO_CONFORME',
  'APP_OBRIGATORIO_AUSENTE',
  'PATCH_DESATUALIZADO',
  'SO_OBSOLETO',
  'STORAGE_CRITICO',
  'DISPOSITIVO_ORFAO',
  'LINHA_SEM_USO',
  'BATERIA_DEGRADADA',
]);

export const alertaSeveridadeEnum = pgEnum('alerta_severidade', ['ALTA', 'MEDIA', 'BAIXA']);

export const alertas = pgTable(
  'alertas',
  {
    id: uuidPk(),
    dispositivoId: uuid('dispositivo_id')
      .notNull()
      .references(() => dispositivos.id),
    tipo: alertaTipoEnum('tipo').notNull(),
    severidade: alertaSeveridadeEnum('severidade').notNull(),
    titulo: text('titulo').notNull(),
    detalhes: jsonb('detalhes'),
    // Sem `.references()` de propósito, igual `auditoria.ator_id` — um
    // alerta reconhecido por alguém que depois é removido do sistema não
    // deve virar erro de FK nem apagar o rastro de quem reconheceu. A seção
    // 6 também não marca este campo com "(FK)", diferente dos outros FKs
    // da tabela — mantido consistente com isso.
    reconhecidoPor: uuid('reconhecido_por'),
    reconhecidoEm: timestamp('reconhecido_em', { withTimezone: true }),
    resolvidoEm: timestamp('resolvido_em', { withTimezone: true }),
    criadoEm: criadoEm(),
  },
  (t) => [
    // Índice parcial: só as linhas em aberto entram no índice. É a query
    // mais frequente do sistema (dashboard de alertas ativos) e a tabela só
    // cresce — sem o filtro parcial, o índice cresceria pra sempre com
    // linhas resolvidas que ninguém mais consulta por esse critério.
    index('alertas_resolvido_em_aberto_idx')
      .on(t.resolvidoEm)
      .where(sql`${t.resolvidoEm} is null`),
  ],
);
