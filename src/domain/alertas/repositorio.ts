import { and, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { alertas } from '../../db/schema/alertas.ts';

export type Alerta = typeof alertas.$inferSelect;
export type NovoAlerta = typeof alertas.$inferInsert;
export type TipoAlerta = NovoAlerta['tipo'];

// Aceita `db` OU um `tx` — mesmo padrão de `domain/auditoria/registrar.ts`:
// os handlers de evento (seção 8) e o motor de alertas (Fase 6) chamam isso
// dentro de uma transação, pra que abrir/fechar um alerta seja parte do
// mesmo commit/rollback do resto do processamento.
type Executor = Pick<typeof db, 'insert' | 'update' | 'select'>;

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
  // `target` precisa casar EXATAMENTE (colunas + predicado) com um dos dois
  // índices parciais (ADR-020, ADR-027) — sem isso o Postgres não reconhece
  // nenhum dos dois como "arbiter" válido pro `ON CONFLICT` e a query falha
  // em runtime com "no unique or exclusion constraint matching". `LINHA_SEM_
  // USO` é o único tipo que preenche `linhaId` em vez de `dispositivoId`.
  const target = input.linhaId
    ? [alertas.linhaId, alertas.tipo]
    : [alertas.dispositivoId, alertas.tipo];

  const [alerta] = await executor
    .insert(alertas)
    .values(input)
    .onConflictDoNothing({ target, where: isNull(alertas.resolvidoEm) })
    .returning();
  return alerta;
}

/**
 * Contraparte de `abrirAlertaSeNaoExistir` — o motor de alertas (Fase 6)
 * chama isso a cada verificação pra fechar sozinho um alerta cuja condição
 * não é mais verdadeira (ex.: dispositivo voltou a ficar `COMPLIANT`,
 * storage foi liberado). Idempotente por natureza: se não havia alerta
 * aberto, o `UPDATE` só afeta zero linhas, sem erro.
 */
export async function resolverAlertaSeAberto(
  executor: Executor,
  dispositivoId: string,
  tipo: TipoAlerta,
): Promise<void> {
  await executor
    .update(alertas)
    .set({ resolvidoEm: new Date() })
    .where(
      and(
        eq(alertas.dispositivoId, dispositivoId),
        eq(alertas.tipo, tipo),
        isNull(alertas.resolvidoEm),
      ),
    );
}

/** Mesma ideia de `resolverAlertaSeAberto`, pro caso `LINHA_SEM_USO` (chave por `linhaId`, não `dispositivoId`). */
export async function resolverAlertaDeLinhaSeAberto(
  executor: Executor,
  linhaId: string,
  tipo: TipoAlerta,
): Promise<void> {
  await executor
    .update(alertas)
    .set({ resolvidoEm: new Date() })
    .where(and(eq(alertas.linhaId, linhaId), eq(alertas.tipo, tipo), isNull(alertas.resolvidoEm)));
}

export interface FiltrosListarAlertas {
  dispositivoId?: string;
  tipo?: TipoAlerta;
  severidade?: NovoAlerta['severidade'];
  /** `true` = só abertos (padrão), `false` = só resolvidos, ausente = todos. */
  aberto?: boolean;
  limit?: number;
  cursor?: string;
}

export interface PaginaAlertas {
  itens: Alerta[];
  proximoCursor: string | undefined;
}

export async function listarAlertas(filtros: FiltrosListarAlertas): Promise<PaginaAlertas> {
  const limit = Math.min(Math.max(filtros.limit ?? 25, 1), 100);

  const condicoes = [];
  if (filtros.dispositivoId) condicoes.push(eq(alertas.dispositivoId, filtros.dispositivoId));
  if (filtros.tipo) condicoes.push(eq(alertas.tipo, filtros.tipo));
  if (filtros.severidade) condicoes.push(eq(alertas.severidade, filtros.severidade));
  if (filtros.aberto === true) condicoes.push(isNull(alertas.resolvidoEm));
  if (filtros.aberto === false) condicoes.push(isNotNull(alertas.resolvidoEm));
  // Achado numa revisão: a lista é `desc(criadoEm)` (mais recente primeiro),
  // mas o cursor comparava `gt` (ids MAIORES — os mesmos alertas recentes de
  // novo) em vez de `lt` (ids MENORES — os próximos, mais antigos). `id`
  // (UUID v7) é ordenável por tempo de criação, na mesma direção de
  // `criadoEm` — por isso dá pra paginar por ele, igual a listarDispositivos
  // faz (lá a ordenação é ascendente, por isso `gt` é o lado certo ali).
  if (filtros.cursor) condicoes.push(lt(alertas.id, filtros.cursor));

  const linhas = await db
    .select()
    .from(alertas)
    .where(condicoes.length > 0 ? and(...condicoes) : undefined)
    .orderBy(desc(alertas.criadoEm))
    .limit(limit + 1);

  const temMais = linhas.length > limit;
  const pagina = temMais ? linhas.slice(0, limit) : linhas;

  return { itens: pagina, proximoCursor: temMais ? pagina[pagina.length - 1]?.id : undefined };
}

export async function buscarAlertaPorId(id: string): Promise<Alerta | undefined> {
  const [alerta] = await db.select().from(alertas).where(eq(alertas.id, id)).limit(1);
  return alerta;
}

/** `POST /alertas/:id/reconhecer` (seção 9) — só registra quem viu, não fecha o alerta. */
export async function reconhecerAlerta(id: string, usuarioId: string): Promise<Alerta | undefined> {
  const [alerta] = await db
    .update(alertas)
    .set({ reconhecidoPor: usuarioId, reconhecidoEm: new Date() })
    .where(eq(alertas.id, id))
    .returning();
  return alerta;
}

/** `POST /alertas/:id/resolver` — encerramento manual (ex.: ação corretiva feita fora do sistema). */
export async function resolverAlertaManualmente(id: string): Promise<Alerta | undefined> {
  const [alerta] = await db
    .update(alertas)
    .set({ resolvidoEm: new Date() })
    .where(eq(alertas.id, id))
    .returning();
  return alerta;
}
