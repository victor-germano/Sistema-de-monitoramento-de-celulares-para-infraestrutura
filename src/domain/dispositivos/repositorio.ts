import { and, eq, gt, ilike, isNull, lt, notInArray, or } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { dispositivos, dispositivoApps } from '../../db/schema/dispositivos.ts';
import { colaboradores } from '../../db/schema/colaboradores.ts';
import { escaparTermoBusca } from '../../shared/sql-like.ts';

export type Dispositivo = typeof dispositivos.$inferSelect;
export type NovoDispositivo = typeof dispositivos.$inferInsert;
export type DispositivoApp = typeof dispositivoApps.$inferSelect;
export type NovoDispositivoApp = typeof dispositivoApps.$inferInsert;

// Aceita `db` OU um `tx` — mesmo padrão de `domain/auditoria/registrar.ts`:
// os handlers do consumer Pub/Sub chamam essas funções DENTRO da transação
// da mensagem (seção 8), pra que um erro no meio do processamento desfaça
// tudo, inclusive o que já tinha sido gravado aqui.
type Executor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

export async function buscarDispositivoPorAmapiName(
  executor: Executor,
  amapiName: string,
): Promise<Dispositivo | undefined> {
  const [dispositivo] = await executor
    .select()
    .from(dispositivos)
    .where(eq(dispositivos.amapiName, amapiName))
    .limit(1);
  return dispositivo;
}

/**
 * Usado por `PATCH /devices/:id` pra checar o índice único de `patrimonio`
 * ANTES do update — achado numa revisão: sem isso, vincular um patrimônio
 * já usado por outro device batia direto no índice único do banco e
 * quebrava com 500 genérico, em vez do 409 amigável que o mesmo padrão
 * (checar-e-retornar-409) já usa pra matrícula/número em outros módulos.
 */
export async function buscarDispositivoPorPatrimonio(
  patrimonio: string,
): Promise<Dispositivo | undefined> {
  const [dispositivo] = await db
    .select()
    .from(dispositivos)
    .where(eq(dispositivos.patrimonio, patrimonio))
    .limit(1);
  return dispositivo;
}

/**
 * Achado numa revisão: faltava o mesmo `leftJoin` com `colaboradores` que
 * `listarDispositivos` já faz — `GET /devices/:id` devolvia `colaboradorNome`
 * ausente mesmo para um dispositivo com colaborador vinculado, inconsistente
 * com `GET /devices` pro mesmo registro (docs/api/devices.md documenta o
 * mesmo formato de resposta pras duas rotas).
 */
export async function buscarDispositivoPorId(
  id: string,
): Promise<ItemListaDispositivo | undefined> {
  const [linha] = await db
    .select({ dispositivo: dispositivos, colaboradorNome: colaboradores.nome })
    .from(dispositivos)
    .leftJoin(colaboradores, eq(dispositivos.colaboradorId, colaboradores.id))
    .where(eq(dispositivos.id, id))
    .limit(1);
  if (!linha) return undefined;
  return { ...linha.dispositivo, colaboradorNome: linha.colaboradorNome };
}

export async function criarDispositivo(
  executor: Executor,
  dados: NovoDispositivo,
): Promise<Dispositivo> {
  const [dispositivo] = await executor.insert(dispositivos).values(dados).returning();
  if (!dispositivo) {
    throw new Error('falha ao criar dispositivo — insert não retornou linha');
  }
  return dispositivo;
}

export async function atualizarDispositivoPorAmapiName(
  executor: Executor,
  amapiName: string,
  dados: Partial<NovoDispositivo>,
): Promise<Dispositivo | undefined> {
  const [dispositivo] = await executor
    .update(dispositivos)
    .set({ ...dados, atualizadoEm: new Date() })
    .where(eq(dispositivos.amapiName, amapiName))
    .returning();
  return dispositivo;
}

export interface VinculoDispositivo {
  colaboradorId?: string | null;
  linhaId?: string | null;
  patrimonio?: string | null;
  ativo?: boolean;
}

/**
 * Usado por `PATCH /devices/:id` (seção 10, Fase 4) — só os 4 campos que a
 * rota expõe. Devolve `colaboradorNome` junto (mesmo `leftJoin` de
 * `buscarDispositivoPorId`) — achado testando a edição manualmente: sem
 * isso, o frontend que reusa a resposta do PATCH pra atualizar a tela
 * perdia o nome do colaborador mesmo com o vínculo salvo corretamente.
 */
export async function atualizarVinculoDispositivo(
  id: string,
  vinculo: VinculoDispositivo,
): Promise<ItemListaDispositivo | undefined> {
  const [dispositivo] = await db
    .update(dispositivos)
    .set({ ...vinculo, atualizadoEm: new Date() })
    .where(eq(dispositivos.id, id))
    .returning();
  if (!dispositivo) return undefined;
  return buscarDispositivoPorId(dispositivo.id);
}

/**
 * Sincroniza o inventário de apps do device: upsert por `(dispositivoId,
 * packageName)` pros apps reportados, e APAGA qualquer linha antiga de um
 * pacote que não está mais no relatório — achado numa revisão: antes só
 * fazia upsert, nunca removia; um app desinstalado deixava uma linha
 * "fantasma" pra sempre, e `APP_OBRIGATORIO_AUSENTE` (que lê esta tabela
 * direto) nunca detectava a ausência de verdade.
 *
 * `apps` vazio é um relatório válido ("o device não tem nenhum app
 * reportável agora", mesma convenção já usada no resto deste módulo pra
 * `APP_OBRIGATORIO_AUSENTE") — `notInArray` com lista vazia já resolve pra
 * `true` (apaga tudo do device), sem precisar de um `if` separado aqui.
 */
export async function upsertDispositivoApps(
  executor: Executor,
  dispositivoId: string,
  apps: readonly Omit<NovoDispositivoApp, 'id' | 'dispositivoId'>[],
): Promise<void> {
  await executor.delete(dispositivoApps).where(
    and(
      eq(dispositivoApps.dispositivoId, dispositivoId),
      notInArray(
        dispositivoApps.packageName,
        apps.map((app) => app.packageName),
      ),
    ),
  );

  for (const app of apps) {
    const [existente] = await executor
      .select({ id: dispositivoApps.id })
      .from(dispositivoApps)
      .where(
        and(
          eq(dispositivoApps.dispositivoId, dispositivoId),
          eq(dispositivoApps.packageName, app.packageName),
        ),
      )
      .limit(1);

    if (existente) {
      await executor.update(dispositivoApps).set(app).where(eq(dispositivoApps.id, existente.id));
    } else {
      await executor.insert(dispositivoApps).values({ ...app, dispositivoId });
    }
  }
}

// Aceita `executor` (default `db`) por um motivo concreto, não só
// consistência: o handler `STATUS_REPORT` (Fase 4) chama isto DEPOIS de um
// `upsertDispositivoApps` na mesma transação, pra checar `APP_OBRIGATORIO_
// AUSENTE` — se lesse via `db` direto (conexão fora da transação), não
// enxergaria o upsert ainda não commitado e compararia contra dados velhos.
export async function listarAppsDoDispositivo(
  executor: Executor,
  dispositivoId: string,
): Promise<DispositivoApp[]> {
  return executor
    .select()
    .from(dispositivoApps)
    .where(eq(dispositivoApps.dispositivoId, dispositivoId));
}

export interface FiltrosListarDispositivos {
  filial?: string;
  departamento?: string;
  complianceState?: string;
  politicaId?: string;
  colaboradorId?: string;
  /** Busca livre — casa contra patrimônio, IMEI, serial e modelo. */
  busca?: string;
  semCheckinDias?: number;
  limit?: number;
  /** `id` (UUID v7, ordenável por tempo) do último item da página anterior. */
  cursor?: string;
}

export interface ItemListaDispositivo extends Dispositivo {
  colaboradorNome: string | null;
}

export interface PaginaDispositivos {
  itens: ItemListaDispositivo[];
  proximoCursor: string | undefined;
}

/**
 * Paginação por CURSOR (seção 11: "nunca offset em tabela grande"), usando
 * o próprio `id` como chave — UUID v7 é ordenável por tempo de criação, e
 * diferente de `ultimo_checkin` (que muda a cada check-in do device), `id`
 * nunca muda depois de criado. Isso é o que torna o cursor estável entre
 * páginas consecutivas.
 */
export async function listarDispositivos(
  filtros: FiltrosListarDispositivos,
): Promise<PaginaDispositivos> {
  const limit = Math.min(Math.max(filtros.limit ?? 25, 1), 100);

  const condicoes = [];
  if (filtros.filial) condicoes.push(eq(colaboradores.filial, filtros.filial));
  if (filtros.departamento) condicoes.push(eq(colaboradores.departamento, filtros.departamento));
  if (filtros.complianceState) {
    condicoes.push(eq(dispositivos.complianceState, filtros.complianceState));
  }
  if (filtros.politicaId) condicoes.push(eq(dispositivos.politicaId, filtros.politicaId));
  if (filtros.colaboradorId) condicoes.push(eq(dispositivos.colaboradorId, filtros.colaboradorId));
  if (filtros.semCheckinDias !== undefined) {
    const limiteData = new Date(Date.now() - filtros.semCheckinDias * 24 * 60 * 60 * 1000);
    condicoes.push(
      or(isNull(dispositivos.ultimoCheckin), lt(dispositivos.ultimoCheckin, limiteData)),
    );
  }
  if (filtros.busca) {
    const termo = `%${escaparTermoBusca(filtros.busca)}%`;
    condicoes.push(
      or(
        ilike(dispositivos.patrimonio, termo),
        ilike(dispositivos.imei, termo),
        ilike(dispositivos.serial, termo),
        ilike(dispositivos.modelo, termo),
      ),
    );
  }
  if (filtros.cursor) condicoes.push(gt(dispositivos.id, filtros.cursor));

  const linhas = await db
    .select({ dispositivo: dispositivos, colaboradorNome: colaboradores.nome })
    .from(dispositivos)
    .leftJoin(colaboradores, eq(dispositivos.colaboradorId, colaboradores.id))
    .where(condicoes.length > 0 ? and(...condicoes) : undefined)
    .orderBy(dispositivos.id)
    // Pede um a mais só pra saber se há próxima página, sem outra query.
    .limit(limit + 1);

  const temMais = linhas.length > limit;
  const pagina = temMais ? linhas.slice(0, limit) : linhas;

  return {
    itens: pagina.map(({ dispositivo, colaboradorNome }) => ({ ...dispositivo, colaboradorNome })),
    proximoCursor: temMais ? pagina[pagina.length - 1]?.dispositivo.id : undefined,
  };
}
