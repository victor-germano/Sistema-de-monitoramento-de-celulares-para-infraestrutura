import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { criadoEm, uuidPk } from './_shared.ts';
import { usuarios } from './usuarios.ts';

export const politicas = pgTable(
  'politicas',
  {
    id: uuidPk(),
    // slug único — é o que a URL/rota usa pra identificar a política nos
    // relatórios e no `amapi_name`, junto com o nome amigável pro admin.
    nome: text('nome').notNull(),
    amapiName: text('amapi_name'),
    descricao: text('descricao'),
    // Payload cru que vai (depois de `enforceInvariants`, seção 3) pra
    // `policies.patch` da AMAPI. `politicas.payload` é sempre o da versão
    // ATIVA; o histórico completo vive em `politicas_versoes` (append-only).
    payload: jsonb('payload').notNull(),
    versao: integer('versao').notNull().default(1),
    ativa: boolean('ativa').notNull().default(true),
    criadoPor: uuid('criado_por').references(() => usuarios.id),
    criadoEm: criadoEm(),
  },
  (t) => [uniqueIndex('politicas_nome_idx').on(t.nome)],
);

// Append-only por design: nenhuma rota faz UPDATE/DELETE aqui. Rollback
// (seção 6/7) cria uma linha NOVA com o payload antigo — nunca apaga
// histórico nem edita uma versão já gravada. O `payload` restaurado passa
// por `enforceInvariants` de novo antes de subir, igual qualquer outro.
export const politicasVersoes = pgTable(
  'politicas_versoes',
  {
    id: uuidPk(),
    politicaId: uuid('politica_id')
      .notNull()
      .references(() => politicas.id),
    versao: integer('versao').notNull(),
    payload: jsonb('payload').notNull(),
    diffResumo: text('diff_resumo'),
    criadoPor: uuid('criado_por').references(() => usuarios.id),
    criadoEm: criadoEm(),
  },
  (t) => [
    // Achado numa auditoria de performance: `GET /policies/:id/versoes` e o
    // lookup de `POST /policies/:id/rollback` filtram por esta coluna numa
    // tabela append-only (só cresce, nunca tem UPDATE/DELETE) sem índice.
    index('politicas_versoes_politica_id_idx').on(t.politicaId),
  ],
);
