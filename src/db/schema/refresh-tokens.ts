import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidPk } from './_shared.ts';
import { usuarios } from './usuarios.ts';

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuidPk(),
  usuarioId: uuid('usuario_id')
    .notNull()
    .references(() => usuarios.id),
  // Nunca o token opaco em texto puro no banco — só o hash. Comparação na
  // hora do refresh é feita hasheando o token recebido e comparando o hash,
  // igual senha. Um dump do banco não expõe token nenhum utilizável.
  tokenHash: text('token_hash').notNull(),
  expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
  revogadoEm: timestamp('revogado_em', { withTimezone: true }),
  // Auto-referência: aponta pro token novo criado na rotação. Cadeia
  // percorrível pra auditoria ("esse token foi rotacionado 4 vezes desde o
  // login"); não é usada pra validar nada em runtime, só histórico.
  substituidoPor: uuid('substituido_por').references((): AnyPgColumn => refreshTokens.id),
  ip: text('ip'),
  userAgent: text('user_agent'),
});
