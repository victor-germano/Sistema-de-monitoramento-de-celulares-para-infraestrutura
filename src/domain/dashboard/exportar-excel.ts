// Exportação do resumo do dashboard em .xlsx (seção 12 não especifica
// formato de exportação — aditivo ao `GET /dashboard` existente, nunca um
// substituto: a rota JSON continua sendo o que a futura interface consome
// pra renderizar o dashboard ao vivo; esta é só pra quem quer levar o número
// pra uma reunião/planilha).
import ExcelJS from 'exceljs';
import type { ResumoDashboard } from './repositorio.ts';

function adicionarAbaDeContagem(
  workbook: ExcelJS.Workbook,
  nome: string,
  colunaChave: string,
  registro: Record<string, number>,
): void {
  const aba = workbook.addWorksheet(nome);
  aba.columns = [
    { header: colunaChave, key: 'chave', width: 30 },
    { header: 'Quantidade', key: 'total', width: 15 },
  ];
  aba.getRow(1).font = { bold: true };
  for (const [chave, total] of Object.entries(registro)) {
    aba.addRow({ chave, total });
  }
}

export async function gerarPlanilhaDashboard(resumo: ResumoDashboard): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Sistema de Monitoramento de Celulares — Grupo Roveri';
  workbook.created = new Date();

  const resumoAba = workbook.addWorksheet('Resumo');
  resumoAba.columns = [
    { header: 'Indicador', key: 'indicador', width: 40 },
    { header: 'Valor', key: 'valor', width: 15 },
  ];
  resumoAba.getRow(1).font = { bold: true };
  resumoAba.addRows([
    { indicador: 'Dispositivos — total', valor: resumo.dispositivos.total },
    { indicador: 'Dispositivos — ativos', valor: resumo.dispositivos.ativos },
    { indicador: 'Alertas abertos — total', valor: resumo.alertasAbertos.total },
    { indicador: 'Colaboradores — total', valor: resumo.colaboradores.total },
    { indicador: 'Colaboradores — ativos', valor: resumo.colaboradores.ativos },
    { indicador: 'Linhas — total', valor: resumo.linhas.total },
  ]);

  adicionarAbaDeContagem(
    workbook,
    'Dispositivos por conformidade',
    'Compliance state',
    resumo.dispositivos.porComplianceState,
  );
  adicionarAbaDeContagem(
    workbook,
    'Alertas por tipo',
    'Tipo de alerta',
    resumo.alertasAbertos.porTipo,
  );
  adicionarAbaDeContagem(
    workbook,
    'Alertas por severidade',
    'Severidade',
    resumo.alertasAbertos.porSeveridade,
  );
  adicionarAbaDeContagem(workbook, 'Linhas por status', 'Status', resumo.linhas.porStatus);

  // `writeBuffer()` já retorna um Node Buffer em runtime, mas o tipo público
  // do ExcelJS (`ExcelJS.Buffer`) não é nominalmente o mesmo `Buffer` que o
  // resto do projeto usa (@types/node mais novo tornou `Buffer` genérico,
  // `Buffer<ArrayBufferLike>`) — `Buffer.from(...)` normaliza pro tipo real
  // do projeto em vez de só calar o typechecker com um cast.
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
