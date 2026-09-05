import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { criadoEm, uuidPk } from './_shared.ts';

// Os 4 papéis da seção 5 da spec, como enum de banco — não texto livre nem
// check constraint solto. Um valor de role fora dessas 4 opções vira erro de
// schema, não um bug silencioso que só aparece em runtime no RBAC.
export const roleEnum = pgEnum('role', ['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR']);
export type Role = (typeof roleEnum.enumValues)[number];

export const usuarios = pgTable(
  'usuarios',
  {
    id: uuidPk(),
    // `sub` do provedor OIDC: identificador estável do usuário no IdP, não
    // muda se o e-mail mudar. É o que liga o registro interno à identidade
    // corporativa real — ver ADR-003 (abstração por provedor).
    oidcSubject: text('oidc_subject').notNull(),
    email: text('email').notNull(),
    nome: text('nome').notNull(),
    role: roleEnum('role').notNull().default('VIEWER'),
    ativo: boolean('ativo').notNull().default(true),
    ultimoLogin: timestamp('ultimo_login', { withTimezone: true }),
    criadoEm: criadoEm(),
  },
  (t) => [uniqueIndex('usuarios_oidc_subject_idx').on(t.oidcSubject)],
);
