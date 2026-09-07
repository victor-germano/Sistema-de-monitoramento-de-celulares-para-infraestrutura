import { and, eq, gt, ilike, or } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { colaboradores } from '../../db/schema/colaboradores.ts';

export type Colaborador = typeof colaboradores.$inferSelect;
export type NovoColaborador = typeof colaboradores.$inferInsert;

export async function buscarColaboradorPorId(id: string): Promise<Colaborador | undefined> {
  const [colaborador] = await db
    .select()
    .from(colaboradores)
    .where(eq(colaboradores.id, id))
    .limit(1);
  return colaborador;
}

export async function buscarColaboradorPorMatricula(
  matricula: string,
): Promise<Colaborador | undefined> {
  const [colaborador] = await db
    .select()
    .from(colaboradores)
    .where(eq(colaboradores.matricula, matricula))
    .limit(1);
  return colaborador;
}

export async function criarColaborador(dados: NovoColaborador): Promise<Colaborador> {
  const [colaborador] = await db.insert(colaboradores).values(dados).returning();
  if (!colaborador) throw new Error('falha ao criar colaborador — insert não retornou linha');
  return colaborador;
}

export async function atualizarColaborador(
  id: string,
  dados: Partial<NovoColaborador>,
): Promise<Colaborador | undefined> {
  const [colaborador] = await db
    .update(colaboradores)
    .set({ ...dados, atualizadoEm: new Date() })
    .where(eq(colaboradores.id, id))
    .returning();
  return colaborador;
}

export interface FiltrosListarColaboradores {
  filial?: string;
  departamento?: string;
  ativo?: boolean;
  busca?: string;
  limit?: number;
  /** `id` (UUID v7) do último item da página anterior — cursor, nunca offset (seção 11). */
  cursor?: string;
}

export interface PaginaColaboradores {
  itens: Colaborador[];
  proximoCursor: string | undefined;
}

export async function listarColaboradores(
  filtros: FiltrosListarColaboradores,
): Promise<PaginaColaboradores> {
  const limit = Math.min(Math.max(filtros.limit ?? 25, 1), 100);

  const condicoes = [];
  if (filtros.filial) condicoes.push(eq(colaboradores.filial, filtros.filial));
  if (filtros.departamento) condicoes.push(eq(colaboradores.departamento, filtros.departamento));
  if (filtros.ativo !== undefined) condicoes.push(eq(colaboradores.ativo, filtros.ativo));
  if (filtros.busca) {
    const termo = `%${filtros.busca}%`;
    condicoes.push(
      or(
        ilike(colaboradores.nome, termo),
        ilike(colaboradores.matricula, termo),
        ilike(colaboradores.email, termo),
      ),
    );
  }
  if (filtros.cursor) condicoes.push(gt(colaboradores.id, filtros.cursor));

  const linhas = await db
    .select()
    .from(colaboradores)
    .where(condicoes.length > 0 ? and(...condicoes) : undefined)
    .orderBy(colaboradores.id)
    .limit(limit + 1);

  const temMais = linhas.length > limit;
  const pagina = temMais ? linhas.slice(0, limit) : linhas;

  return { itens: pagina, proximoCursor: temMais ? pagina[pagina.length - 1]?.id : undefined };
}
