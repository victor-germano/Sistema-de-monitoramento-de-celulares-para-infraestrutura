import { date, integer, numeric, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { uuidPk } from './_shared.ts';

// `status` é uma categoria que o PRÓPRIO sistema controla (transições feitas
// por nós, não reportadas por um terceiro) — enum de banco faz sentido aqui.
// `operadora`, ao contrário, é texto livre por decisão do Victor
// (2026-09-04, ver ADR-005): "todas as operadoras famosas atualmente, de um
// modo geral" — sem lista fechada.
export const linhaStatusEnum = pgEnum('linha_status', ['ativa', 'suspensa', 'cancelada']);

export const linhas = pgTable(
  'linhas',
  {
    id: uuidPk(),
    numero: text('numero').notNull(),
    operadora: text('operadora'),
    iccid: text('iccid'),
    planoDadosGb: integer('plano_dados_gb'),
    valorMensal: numeric('valor_mensal', { precision: 10, scale: 2 }),
    status: linhaStatusEnum('status').notNull().default('ativa'),
    dataAtivacao: date('data_ativacao'),
    observacoes: text('observacoes'),
  },
  (t) => [uniqueIndex('linhas_numero_idx').on(t.numero)],
);
