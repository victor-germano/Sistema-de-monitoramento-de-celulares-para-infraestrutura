import { boolean, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { criadoEm, uuidPk } from './_shared.ts';

export const colaboradores = pgTable(
  'colaboradores',
  {
    id: uuidPk(),
    matricula: text('matricula').notNull(),
    nome: text('nome').notNull(),
    email: text('email'),
    filial: text('filial'),
    departamento: text('departamento'),
    centroCusto: text('centro_custo'),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: criadoEm(),
    // Sem trigger de banco — ver comentário em `_shared.ts`. Atualizado pela
    // aplicação a cada PATCH em /colaboradores/:id.
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('colaboradores_matricula_idx').on(t.matricula)],
);
