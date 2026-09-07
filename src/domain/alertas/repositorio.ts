import { isNull } from 'drizzle-orm';
import type { db } from '../../db/client.ts';
import { alertas } from '../../db/schema/alertas.ts';

export type Alerta = typeof alertas.$inferSelect;
export type NovoAlerta = typeof alertas.$inferInsert;

// Aceita `db` OU um `tx` — mesmo padrão de `domain/auditoria/registrar.ts`:
// o handler `STATUS_REPORT` (seção 8) chama isso dentro da transação da
// mensagem, pra que abrir o alerta seja parte do mesmo commit/rollback do
// resto do processamento.
type Executor = Pick<typeof db, 'insert'>;

/**
 * Idempotente via `ON CONFLICT DO NOTHING` contra o índice único parcial
 * `alertas_aberto_unico_idx` (ADR-020: um alerta ABERTO por dispositivo+tipo)
 * — não um check-then-insert, que teria uma janela de corrida entre duas
 * mensagens do mesmo device processadas em paralelo (não deveria acontecer
 * dado que o consumer processa uma mensagem por vez, mas o índice único é
 * quem garante isso de verdade, não a ordem de processamento).
 *
 * Retorna `undefined` quando já havia um alerta aberto do mesmo tipo — quem
 * chama não precisa (nem deve) tratar isso como erro.
 */
export async function abrirAlertaSeNaoExistir(
  executor: Executor,
  input: Omit<NovoAlerta, 'id' | 'criadoEm' | 'reconhecidoPor' | 'reconhecidoEm' | 'resolvidoEm'>,
): Promise<Alerta | undefined> {
  const [alerta] = await executor
    .insert(alertas)
    .values(input)
    // `where` precisa casar exatamente com o predicado do índice parcial
    // (`alertas_aberto_unico_idx`) — sem isso o Postgres não reconhece o
    // índice como "arbiter" válido pro `ON CONFLICT` e a query falha em
    // runtime com "no unique or exclusion constraint matching".
    .onConflictDoNothing({
      target: [alertas.dispositivoId, alertas.tipo],
      where: isNull(alertas.resolvidoEm),
    })
    .returning();
  return alerta;
}
