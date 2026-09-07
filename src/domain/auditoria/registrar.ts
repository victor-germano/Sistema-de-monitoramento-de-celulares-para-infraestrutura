import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../../db/client.ts';
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

export type RegistroAuditoria = typeof auditoria.$inferSelect;

export interface FiltrosAuditoria {
  entidade?: string;
  entidadeId?: string;
  limit?: number;
  /** `id` (bigserial) do último item da página anterior — cursor pra trás, já que a ordenação é DESC. */
  cursor?: number;
}

export interface PaginaAuditoria {
  itens: RegistroAuditoria[];
  proximoCursor: number | undefined;
}

/**
 * Visão global, filtrável — é o que `GET /auditoria` (ADR-004: único acesso
 * do papel `AUDITOR` à trilha de auditoria) expõe. Paginação por cursor
 * (`id`, nunca offset — seção 11); `id` é `bigserial`, monotonicamente
 * crescente por ordem de inserção, o que o torna estável entre páginas
 * mesmo com `ocorrido_em` empatado.
 */
export async function listarAuditoria(filtros: FiltrosAuditoria): Promise<PaginaAuditoria> {
  const limit = Math.min(Math.max(filtros.limit ?? 50, 1), 200);

  const condicoes = [];
  if (filtros.entidade) condicoes.push(eq(auditoria.entidade, filtros.entidade));
  if (filtros.entidadeId) condicoes.push(eq(auditoria.entidadeId, filtros.entidadeId));
  if (filtros.cursor !== undefined) condicoes.push(lt(auditoria.id, filtros.cursor));

  const linhas = await db
    .select()
    .from(auditoria)
    .where(condicoes.length > 0 ? and(...condicoes) : undefined)
    .orderBy(desc(auditoria.id))
    .limit(limit + 1);

  const temMais = linhas.length > limit;
  const pagina = temMais ? linhas.slice(0, limit) : linhas;

  return { itens: pagina, proximoCursor: temMais ? pagina[pagina.length - 1]?.id : undefined };
}

/** Usado por `GET /devices/:id/auditoria` (seção 10, Fase 4) — histórico de ações sobre UMA entidade. */
export async function listarAuditoriaPorEntidade(
  entidade: string,
  entidadeId: string,
  limit = 50,
): Promise<RegistroAuditoria[]> {
  return (await listarAuditoria({ entidade, entidadeId, limit })).itens;
}
