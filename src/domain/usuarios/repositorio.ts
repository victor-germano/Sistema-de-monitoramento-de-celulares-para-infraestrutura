import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { usuarios, type Role } from '../../db/schema/usuarios.ts';
import { env } from '../../config/env.ts';

export type Usuario = typeof usuarios.$inferSelect;

export async function buscarUsuarioPorOidcSubject(
  oidcSubject: string,
): Promise<Usuario | undefined> {
  const [usuario] = await db
    .select()
    .from(usuarios)
    .where(eq(usuarios.oidcSubject, oidcSubject))
    .limit(1);
  return usuario;
}

export async function buscarUsuarioPorId(id: string): Promise<Usuario | undefined> {
  const [usuario] = await db.select().from(usuarios).where(eq(usuarios.id, id)).limit(1);
  return usuario;
}

export async function listarUsuarios(): Promise<Usuario[]> {
  return db.select().from(usuarios);
}

export interface DadosProvisionamento {
  oidcSubject: string;
  email: string;
  nome: string;
}

/**
 * Provisionamento just-in-time (seção 5): primeiro login cria o registro em
 * `usuarios`. Role é `VIEWER` por padrão — exceto se o e-mail estiver em
 * `BOOTSTRAP_ADMIN_EMAILS`, o mecanismo que resolve o problema do "primeiro
 * ADMIN" (sem ele, ninguém jamais sairia de VIEWER, já que elevação de role
 * é manual e feita por um ADMIN que não existiria ainda). Fora esse caso
 * inicial, elevação de role é sempre via `PATCH /usuarios/:id`.
 */
export async function provisionarUsuario(dados: DadosProvisionamento): Promise<Usuario> {
  const role: Role = env.BOOTSTRAP_ADMIN_EMAILS.includes(dados.email.toLowerCase())
    ? 'ADMIN'
    : 'VIEWER';

  const [usuario] = await db
    .insert(usuarios)
    .values({
      oidcSubject: dados.oidcSubject,
      email: dados.email,
      nome: dados.nome,
      role,
      ultimoLogin: new Date(),
    })
    .returning();

  if (!usuario) {
    throw new Error('falha ao provisionar usuário — insert não retornou linha');
  }

  return usuario;
}

export async function atualizarUltimoLogin(usuarioId: string): Promise<void> {
  await db.update(usuarios).set({ ultimoLogin: new Date() }).where(eq(usuarios.id, usuarioId));
}

export async function atualizarRole(usuarioId: string, role: Role): Promise<Usuario | undefined> {
  const [usuario] = await db
    .update(usuarios)
    .set({ role })
    .where(eq(usuarios.id, usuarioId))
    .returning();
  return usuario;
}
