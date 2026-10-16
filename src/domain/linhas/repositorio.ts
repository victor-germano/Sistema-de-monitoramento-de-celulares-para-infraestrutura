import { and, eq, gt, ilike, or } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { linhas } from '../../db/schema/linhas.ts';
import { escaparTermoBusca } from '../../shared/sql-like.ts';

export type Linha = typeof linhas.$inferSelect;
export type NovaLinha = typeof linhas.$inferInsert;

export async function buscarLinhaPorId(id: string): Promise<Linha | undefined> {
  const [linha] = await db.select().from(linhas).where(eq(linhas.id, id)).limit(1);
  return linha;
}

export async function buscarLinhaPorNumero(numero: string): Promise<Linha | undefined> {
  const [linha] = await db.select().from(linhas).where(eq(linhas.numero, numero)).limit(1);
  return linha;
}

export async function criarLinha(dados: NovaLinha): Promise<Linha> {
  const [linha] = await db.insert(linhas).values(dados).returning();
  if (!linha) throw new Error('falha ao criar linha — insert não retornou linha');
  return linha;
}

export async function atualizarLinha(
  id: string,
  dados: Partial<NovaLinha>,
): Promise<Linha | undefined> {
  const [linha] = await db.update(linhas).set(dados).where(eq(linhas.id, id)).returning();
  return linha;
}

export interface FiltrosListarLinhas {
  status?: (typeof linhas.$inferSelect)['status'];
  operadora?: string;
  busca?: string;
  limit?: number;
  /** `id` (UUID v7) do último item da página anterior — cursor, nunca offset (seção 11). */
  cursor?: string;
}

export interface PaginaLinhas {
  itens: Linha[];
  proximoCursor: string | undefined;
}

export async function listarLinhas(filtros: FiltrosListarLinhas): Promise<PaginaLinhas> {
  const limit = Math.min(Math.max(filtros.limit ?? 25, 1), 100);

  const condicoes = [];
  if (filtros.status) condicoes.push(eq(linhas.status, filtros.status));
  if (filtros.operadora) condicoes.push(eq(linhas.operadora, filtros.operadora));
  if (filtros.busca) {
    const termo = `%${escaparTermoBusca(filtros.busca)}%`;
    condicoes.push(or(ilike(linhas.numero, termo), ilike(linhas.iccid, termo)));
  }
  if (filtros.cursor) condicoes.push(gt(linhas.id, filtros.cursor));

  const linhasResultado = await db
    .select()
    .from(linhas)
    .where(condicoes.length > 0 ? and(...condicoes) : undefined)
    .orderBy(linhas.id)
    .limit(limit + 1);

  const temMais = linhasResultado.length > limit;
  const pagina = temMais ? linhasResultado.slice(0, limit) : linhasResultado;

  return { itens: pagina, proximoCursor: temMais ? pagina[pagina.length - 1]?.id : undefined };
}
