import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Append-only por definição de produto (seção 6/11): sem UPDATE, sem DELETE,
// nem pra ADMIN. O `REVOKE UPDATE, DELETE` de verdade — que faz isso valer
// mesmo contra um bug de código, não só por disciplina — está na migration
// `0001_revoke_auditoria_privileges.sql`, não aqui: `pgTable` só descreve
// colunas/índices, privilégios de banco (GRANT/REVOKE) ficam fora do que o
// drizzle-kit sabe gerar a partir do schema, por isso a migration manual.
//
// `ator_id`/`ator_email` são cópia, não FK — de propósito. Um registro de
// auditoria tem que sobreviver a um usuário sendo removido do sistema anos
// depois; travar isso com `.references()` faria o histórico de auditoria
// depender do ciclo de vida de `usuarios`, o oposto do que uma trilha de
// auditoria deve garantir.
export const auditoria = pgTable(
  'auditoria',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    atorId: uuid('ator_id'),
    atorEmail: text('ator_email'),
    acao: text('acao').notNull(),
    entidade: text('entidade').notNull(),
    entidadeId: text('entidade_id'),
    detalhes: jsonb('detalhes'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    ocorridoEm: timestamp('ocorrido_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('auditoria_ocorrido_em_idx').on(t.ocorridoEm.desc()),
    index('auditoria_entidade_idx').on(t.entidade, t.entidadeId),
  ],
);
