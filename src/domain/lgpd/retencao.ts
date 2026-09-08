// Retenção de dados (Fase 6) — a única purga real nesta fase é
// `eventos_brutos`. `RETENCAO_LOCALIZACAO_DIAS` (documentada em
// `.env.example`) não tem função aqui: a AMAPI não relata localização de
// forma contínua via `STATUS_REPORT` (só via "Lost Mode", fora de escopo
// desta fase por decisão do Victor — ver ADR-026); `dispositivos.
// ultima_localizacao` nunca é preenchida hoje, então não há o que purgar.
import { and, isNotNull, lt } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { eventosBrutos } from '../../db/schema/eventos-brutos.ts';
import { env } from '../../config/env.ts';
import { logger } from '../../shared/logger.ts';

/**
 * Só purga eventos JÁ PROCESSADOS com sucesso (`processado_em` preenchido)
 * — um evento com erro (`processado_em` null) precisa continuar disponível
 * pra `POST /internal/pubsub/replay` até alguém investigar a causa; apagá-lo
 * pela idade destruiria a única cópia do payload original antes de alguém
 * ter chance de corrigir e reprocessar.
 */
export async function purgarEventosBrutosAntigos(): Promise<number> {
  const limite = new Date(Date.now() - env.RETENCAO_EVENTOS_BRUTOS_DIAS * 24 * 60 * 60 * 1000);

  const apagados = await db
    .delete(eventosBrutos)
    .where(and(isNotNull(eventosBrutos.processadoEm), lt(eventosBrutos.processadoEm, limite)))
    .returning({ id: eventosBrutos.id });

  if (apagados.length > 0) {
    logger.info({ quantidade: apagados.length }, 'LGPD: eventos_brutos antigos purgados');
  }
  return apagados.length;
}
