// Agregados pro dashboard (seção 10, Fase 6) — nada de detalhe individual
// aqui, só contagens. "Relatório" no sentido de resumo operacional, não
// exportação de arquivo (seção 12 não especifica formato de exportação;
// se isso for necessário, é aditivo, não um replace deste endpoint).
import { count, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { dispositivos } from '../../db/schema/dispositivos.ts';
import { alertas } from '../../db/schema/alertas.ts';
import { colaboradores } from '../../db/schema/colaboradores.ts';
import { linhas } from '../../db/schema/linhas.ts';

export interface ResumoDashboard {
  dispositivos: {
    total: number;
    ativos: number;
    /** Chave `DESCONHECIDO` cobre devices que nunca mandaram STATUS_REPORT ainda. */
    porComplianceState: Record<string, number>;
  };
  alertasAbertos: {
    total: number;
    porTipo: Record<string, number>;
    porSeveridade: Record<string, number>;
  };
  colaboradores: { total: number; ativos: number };
  linhas: { total: number; porStatus: Record<string, number> };
}

function paraRegistro<T extends string | null>(
  linhas: readonly { chave: T; total: number }[],
  chaveDesconhecida: string,
): Record<string, number> {
  return Object.fromEntries(linhas.map((l) => [l.chave ?? chaveDesconhecida, l.total]));
}

export async function obterResumoDashboard(): Promise<ResumoDashboard> {
  // Achado numa revisão de eficiência: as 10 queries abaixo são
  // independentes entre si (nenhuma usa o resultado de outra) — rodavam em
  // 10 awaits sequenciais, uma depois da outra. `Promise.all` manda todas
  // pro pool de conexões de uma vez; o tempo de resposta passa a ser o da
  // query mais lenta, não a SOMA de todas.
  const [
    [totalDispositivos],
    [dispositivosAtivos],
    porCompliance,
    [totalAlertasAbertos],
    alertasPorTipo,
    alertasPorSeveridade,
    [totalColaboradores],
    [colaboradoresAtivos],
    [totalLinhas],
    linhasPorStatus,
  ] = await Promise.all([
    db.select({ total: count() }).from(dispositivos),
    db.select({ total: count() }).from(dispositivos).where(eq(dispositivos.ativo, true)),
    db
      .select({ chave: dispositivos.complianceState, total: count() })
      .from(dispositivos)
      .groupBy(dispositivos.complianceState),
    db.select({ total: count() }).from(alertas).where(isNull(alertas.resolvidoEm)),
    db
      .select({ chave: alertas.tipo, total: count() })
      .from(alertas)
      .where(isNull(alertas.resolvidoEm))
      .groupBy(alertas.tipo),
    db
      .select({ chave: alertas.severidade, total: count() })
      .from(alertas)
      .where(isNull(alertas.resolvidoEm))
      .groupBy(alertas.severidade),
    db.select({ total: count() }).from(colaboradores),
    db.select({ total: count() }).from(colaboradores).where(eq(colaboradores.ativo, true)),
    db.select({ total: count() }).from(linhas),
    db.select({ chave: linhas.status, total: count() }).from(linhas).groupBy(linhas.status),
  ]);

  return {
    dispositivos: {
      total: totalDispositivos?.total ?? 0,
      ativos: dispositivosAtivos?.total ?? 0,
      porComplianceState: paraRegistro(porCompliance, 'DESCONHECIDO'),
    },
    alertasAbertos: {
      total: totalAlertasAbertos?.total ?? 0,
      porTipo: paraRegistro(alertasPorTipo, 'DESCONHECIDO'),
      porSeveridade: paraRegistro(alertasPorSeveridade, 'DESCONHECIDO'),
    },
    colaboradores: {
      total: totalColaboradores?.total ?? 0,
      ativos: colaboradoresAtivos?.total ?? 0,
    },
    linhas: {
      total: totalLinhas?.total ?? 0,
      porStatus: paraRegistro(linhasPorStatus, 'DESCONHECIDO'),
    },
  };
}
