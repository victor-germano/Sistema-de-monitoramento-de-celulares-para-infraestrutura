import { bigserial, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// Guarda toda mensagem Pub/Sub crua ANTES de processar (seção 8). Se um bug
// de parsing corromper dados derivados (dispositivos, alertas etc.), dá pra
// reprocessar o histórico inteiro sem ter perdido nada — é a rede de
// segurança por trás de `POST /internal/pubsub/replay` (Fase 4).
// `notification_type` fica texto livre pelo mesmo motivo dos campos
// observados em `dispositivos`/`dispositivo_apps` (ver ADR-007): é a AMAPI
// quem define esse enum, não nós.
export const eventosBrutos = pgTable(
  'eventos_brutos',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    notificationType: text('notification_type').notNull(),
    payload: jsonb('payload').notNull(),
    // Unique é o que garante a idempotência do consumer: mensagem repetida
    // (redelivery do Pub/Sub, coisa normal em at-least-once delivery) não
    // duplica processamento — o INSERT falha por conflito e o handler só
    // faz `ack()` e sai, sem reprocessar.
    messageId: text('message_id').notNull(),
    processadoEm: timestamp('processado_em', { withTimezone: true }),
    erro: text('erro'),
  },
  (t) => [uniqueIndex('eventos_brutos_message_id_idx').on(t.messageId)],
);
