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
  const [totalDispositivos] = await db.select({ total: count() }).from(dispositivos);
  const [dispositivosAtivos] = await db
    .select({ total: count() })
    .from(dispositivos)
    .where(eq(dispositivos.ativo, true));
  const porCompliance = await db
    .select({ chave: dispositivos.complianceState, total: count() })
    .from(dispositivos)
    .groupBy(dispositivos.complianceState);

  const [totalAlertasAbertos] = await db
    .select({ total: count() })
    .from(alertas)
    .where(isNull(alertas.resolvidoEm));
  const alertasPorTipo = await db
    .select({ chave: alertas.tipo, total: count() })
    .from(alertas)
    .where(isNull(alertas.resolvidoEm))
    .groupBy(alertas.tipo);
  const alertasPorSeveridade = await db
    .select({ chave: alertas.severidade, total: count() })
    .from(alertas)
    .where(isNull(alertas.resolvidoEm))
    .groupBy(alertas.severidade);

  const [totalColaboradores] = await db.select({ total: count() }).from(colaboradores);
  const [colaboradoresAtivos] = await db
    .select({ total: count() })
    .from(colaboradores)
    .where(eq(colaboradores.ativo, true));

  const [totalLinhas] = await db.select({ total: count() }).from(linhas);
  const linhasPorStatus = await db
    .select({ chave: linhas.status, total: count() })
    .from(linhas)
    .groupBy(linhas.status);

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
