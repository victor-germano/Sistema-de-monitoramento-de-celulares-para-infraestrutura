import { and, eq, gt, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { enrollmentTokens } from '../../db/schema/enrollment-tokens.ts';

export type EnrollmentToken = typeof enrollmentTokens.$inferSelect;
export type NovoEnrollmentToken = typeof enrollmentTokens.$inferInsert;

export interface FiltrosListarEnrollmentTokens {
  usado?: boolean;
  limit?: number;
  cursor?: string;
}

export interface PaginaEnrollmentTokens {
  itens: EnrollmentToken[];
  proximoCursor?: string;
}

export async function buscarEnrollmentTokenPorId(id: string): Promise<EnrollmentToken | undefined> {
  const [token] = await db
    .select()
    .from(enrollmentTokens)
    .where(eq(enrollmentTokens.id, id))
    .limit(1);
  return token;
}

export async function criarEnrollmentTokenLocal(
  dados: NovoEnrollmentToken,
): Promise<EnrollmentToken> {
  const [token] = await db.insert(enrollmentTokens).values(dados).returning();
  if (!token) throw new Error('falha ao criar enrollment_token — insert não retornou linha');
  return token;
}

export async function excluirEnrollmentTokenLocal(id: string): Promise<void> {
  await db.delete(enrollmentTokens).where(eq(enrollmentTokens.id, id));
}

// Mesmo padrão de cursor de `listarDispositivos` (UUID v7 ordenado = ordem
// de criação, sem precisar de coluna extra pra paginar).
export async function listarEnrollmentTokens(
  filtros: FiltrosListarEnrollmentTokens,
): Promise<PaginaEnrollmentTokens> {
  const limit = Math.min(Math.max(filtros.limit ?? 25, 1), 100);

  const condicoes = [];
  if (filtros.usado === true) condicoes.push(isNotNull(enrollmentTokens.usadoEm));
  if (filtros.usado === false) condicoes.push(isNull(enrollmentTokens.usadoEm));
  if (filtros.cursor) condicoes.push(gt(enrollmentTokens.id, filtros.cursor));

  const linhas = await db
    .select()
    .from(enrollmentTokens)
    .where(condicoes.length > 0 ? and(...condicoes) : undefined)
    .orderBy(enrollmentTokens.id)
    .limit(limit + 1);

  const temMais = linhas.length > limit;
  const pagina = temMais ? linhas.slice(0, limit) : linhas;

  return {
    itens: pagina,
    proximoCursor: temMais ? pagina[pagina.length - 1]?.id : undefined,
  };
}
