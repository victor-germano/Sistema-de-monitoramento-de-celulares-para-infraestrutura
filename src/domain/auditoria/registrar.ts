import type { db } from '../../db/client.ts';
import { auditoria } from '../../db/schema/auditoria.ts';

// Aceita `db` OU um `tx` de `db.transaction(...)` — o mesmo shape de
// `.insert(...)`, o único método que esta função usa. Isso é o que permite
// "auditoria gravada na mesma transação da ação" (seção 11): o caller passa
// o `tx` da transação da ação de escrita, e se a transação inteira der
// rollback, o registro de auditoria também some — nunca fica uma auditoria
// "órfã" de uma ação que na prática não aconteceu.
type Executor = Pick<typeof db, 'insert'>;

export interface RegistrarAuditoriaInput {
  /** `null` para ações do próprio sistema (jobs, workers) sem um usuário por trás. */
  ator: { id: string; email: string } | null;
  acao: string;
  entidade: string;
  entidadeId?: string;
  detalhes?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export async function registrarAuditoria(
  executor: Executor,
  input: RegistrarAuditoriaInput,
): Promise<void> {
  await executor.insert(auditoria).values({
    atorId: input.ator?.id,
    atorEmail: input.ator?.email,
    acao: input.acao,
    entidade: input.entidade,
    entidadeId: input.entidadeId,
    detalhes: input.detalhes,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}
