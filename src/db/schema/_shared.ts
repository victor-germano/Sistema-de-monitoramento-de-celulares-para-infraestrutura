import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

// PK padrão do projeto inteiro: UUID v7 gerado na APLICAÇÃO, não no Postgres
// — PG 16 não tem `uuidv7()` nativo (só a partir da v18). Ver ADR-001 em
// docs/DECISOES.md. Efeito prático: um insert feito fora da aplicação
// (`psql` manual, script solto) precisa gerar o UUID na mão, já que não há
// `DEFAULT` no banco cobrindo esse caso.
export const uuidPk = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

// `criado_em` é o único timestamp com default automático no schema inteiro.
// Nenhuma tabela tem `atualizado_em` com trigger de banco — atualizar esse
// campo é responsabilidade explícita da camada de aplicação a cada UPDATE,
// pra manter "o que mudou e quando" visível no código (e na auditoria) em
// vez de escondido dentro de um trigger SQL que ninguém lê no code review.
export const criadoEm = () => timestamp('criado_em', { withTimezone: true }).notNull().defaultNow();
