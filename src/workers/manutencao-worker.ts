// Worker dedicado (`npm run worker:manutencao`, Fase 6) — roda em intervalo
// fixo (`ALERTA_SCAN_INTERVALO_HORAS`, padrão 6h) as duas tarefas de
// manutenção que nenhum evento reativo cobre sozinho:
//   1. Os 3 alertas periódicos (SEM_CHECKIN, DISPOSITIVO_ORFAO,
//      LINHA_SEM_USO) — sobre AUSÊNCIA de algo, só um scan da frota inteira
//      detecta.
//   2. Purga LGPD de `eventos_brutos` antigos.
// Timer simples (`setInterval`), mesmo padrão de `src/workers/watchdog.ts`
// — não BullMQ repeatable job, porque isso é fundamentalmente uma rotina em
// lote (uma vez a cada N horas), não uma fila de trabalho sob demanda.
import { executarScanPeriodico } from '../domain/alertas/motor.ts';
import { purgarEventosBrutosAntigos } from '../domain/lgpd/retencao.ts';
import { env } from '../config/env.ts';
import { logger } from '../shared/logger.ts';

export async function executarRodadaDeManutencao(): Promise<void> {
  try {
    const scan = await executarScanPeriodico();
    logger.info({ scan }, 'manutenção: scan periódico de alertas concluído');
  } catch (erro) {
    logger.error({ err: erro }, 'manutenção: falha no scan periódico de alertas');
  }

  try {
    const eventosPurgados = await purgarEventosBrutosAntigos();
    logger.info({ eventosPurgados }, 'manutenção: purga LGPD concluída');
  } catch (erro) {
    logger.error({ err: erro }, 'manutenção: falha na purga LGPD');
  }
}

export interface WorkerManutencao {
  parar(): void;
}

export function iniciarWorkerManutencao(): WorkerManutencao {
  const intervaloMs = env.ALERTA_SCAN_INTERVALO_HORAS * 60 * 60 * 1000;

  // Primeira rodada imediata no boot — não espera o primeiro intervalo
  // completo pra ter alertas periódicos atualizados (útil sobretudo logo
  // após um deploy/restart do worker).
  void executarRodadaDeManutencao();

  const timer = setInterval(() => void executarRodadaDeManutencao(), intervaloMs);
  timer.unref?.();

  logger.info({ intervaloHoras: env.ALERTA_SCAN_INTERVALO_HORAS }, 'worker de manutenção iniciado');

  return {
    parar() {
      clearInterval(timer);
    },
  };
}

// Entrypoint do processo dedicado — só roda quando o arquivo é executado
// diretamente, não quando importado por teste.
if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = iniciarWorkerManutencao();

  const desligar = (): void => {
    logger.info('worker de manutenção: encerrando...');
    worker.parar();
    process.exit(0);
  };

  process.on('SIGTERM', desligar);
  process.on('SIGINT', desligar);
}
