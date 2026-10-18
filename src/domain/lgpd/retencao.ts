// Retenção de dados (Fase 6) — `eventos_brutos` e `refresh_tokens` são as
// duas purgas reais. `RETENCAO_LOCALIZACAO_DIAS` (documentada em
// `.env.example`) não tem função aqui: a AMAPI não relata localização de
// forma contínua via `STATUS_REPORT` (só via "Lost Mode", fora de escopo
// desta fase por decisão do Victor — ver ADR-026); `dispositivos.
// ultima_localizacao` nunca é preenchida hoje, então não há o que purgar.
import { and, isNotNull, lt } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { eventosBrutos } from '../../db/schema/eventos-brutos.ts';
import { refreshTokens } from '../../db/schema/refresh-tokens.ts';
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

/**
 * Achado numa auditoria de performance (sessão de 17/10): `refresh_tokens`
 * nunca tinha purga — só `eventos_brutos`. Filtra por `expira_em` (não por
 * `revogado_em`), então cobre tanto token revogado quanto token que só
 * expirou sem nunca ser usado de novo (sessão abandonada). A FK de
 * `substituido_por` tem `onDelete: 'set null'` (ver `src/db/schema/
 * refresh-tokens.ts`) justamente pra isso: apagar a ponta mais antiga de
 * uma cadeia de rotação nunca quebra com erro de FK, só perde o elo mais
 * velho aos poucos — a cadeia completa só sobrevive pelos últimos
 * `RETENCAO_REFRESH_TOKENS_DIAS` dias após expirar, não pra sempre.
 */
export async function purgarRefreshTokensAntigos(): Promise<number> {
  const limite = new Date(Date.now() - env.RETENCAO_REFRESH_TOKENS_DIAS * 24 * 60 * 60 * 1000);

  const apagados = await db
    .delete(refreshTokens)
    .where(lt(refreshTokens.expiraEm, limite))
    .returning({ id: refreshTokens.id });

  if (apagados.length > 0) {
    logger.info({ quantidade: apagados.length }, 'LGPD: refresh_tokens antigos purgados');
  }
  return apagados.length;
}
