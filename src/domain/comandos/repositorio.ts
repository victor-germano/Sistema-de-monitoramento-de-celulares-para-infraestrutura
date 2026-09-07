import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { comandos } from '../../db/schema/comandos.ts';

export type Comando = typeof comandos.$inferSelect;

// Só leitura por enquanto (`GET /devices/:id/comandos`, Fase 4) — emissão de
// comando (`POST`) é escopo da Fase 5 (seção 8/10), quando este arquivo
// ganha as funções de escrita.
export async function listarComandosDoDispositivo(
  dispositivoId: string,
  limit = 50,
): Promise<Comando[]> {
  return db
    .select()
    .from(comandos)
    .where(eq(comandos.dispositivoId, dispositivoId))
    .orderBy(desc(comandos.solicitadoEm))
    .limit(limit);
}
