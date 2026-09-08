import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { criadoEm, uuidPk } from './_shared.ts';
import { dispositivos } from './dispositivos.ts';
import { linhas } from './linhas.ts';

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
    // Nullable a partir da Fase 6 (ADR-027): `LINHA_SEM_USO` (seção 9) é o
    // único dos 9 tipos sem um dispositivo associado por definição — o
    // problema é justamente a AUSÊNCIA de um device usando a linha.
    // Exatamente um entre `dispositivo_id`/`linha_id` é preenchido — nunca
    // os dois, nunca nenhum — garantido pelo CHECK abaixo, não só por
    // convenção de quem escreve a query.
    dispositivoId: uuid('dispositivo_id').references(() => dispositivos.id),
    linhaId: uuid('linha_id').references(() => linhas.id),
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
    // ADR-020: único ABERTO por (dispositivo, tipo) — histórico permite
    // vários alertas RESOLVIDOS do mesmo tipo pro mesmo device (isso é o
    // esperado: o problema aconteceu, foi corrigido, aconteceu de novo).
    // É esse índice parcial que torna `abrirAlertaSeNaoExistir` (Fase 4)
    // atômico via `ON CONFLICT DO NOTHING` em vez de um check-then-insert
    // vulnerável a corrida entre duas mensagens Pub/Sub do mesmo device
    // processadas em paralelo.
    uniqueIndex('alertas_aberto_unico_idx')
      .on(t.dispositivoId, t.tipo)
      .where(sql`${t.resolvidoEm} is null`),
    // Mesmo princípio do índice acima, só que pro caso `linha_id` (Fase 6,
    // ADR-027) — dois índices parciais separados em vez de um índice
    // composto pelos dois campos, porque um `UNIQUE (dispositivo_id,
    // linha_id, tipo)` deixaria passar duas linhas com `dispositivo_id`
    // NULL + o mesmo `linha_id`/`tipo` sem problema (Postgres trata NULL
    // como distinto de NULL em índice único) — não é isso que queremos
    // impedir aqui.
    uniqueIndex('alertas_linha_aberto_unico_idx')
      .on(t.linhaId, t.tipo)
      .where(sql`${t.resolvidoEm} is null`),
    check(
      'alertas_dispositivo_ou_linha_check',
      sql`(${t.dispositivoId} is not null) <> (${t.linhaId} is not null)`,
    ),
  ],
);
