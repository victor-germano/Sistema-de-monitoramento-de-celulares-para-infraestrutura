import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidPk } from './_shared.ts';
import { colaboradores } from './colaboradores.ts';
import { dispositivos } from './dispositivos.ts';
import { politicas } from './politicas.ts';
import { usuarios } from './usuarios.ts';

export const enrollmentTokens = pgTable('enrollment_tokens', {
  id: uuidPk(),
  amapiTokenName: text('amapi_token_name'),
  // Nunca o valor do token em texto puro — só o hash. O QR/valor real é
  // devolvido ao TECNICO uma única vez, na criação (seção 10:
  // `POST /enrollment/tokens` retorna `qrPayload`), e nunca mais é
  // recuperável depois — igual senha, igual refresh token.
  valorHash: text('valor_hash').notNull(),
  politicaId: uuid('politica_id').references(() => politicas.id),
  patrimonio: text('patrimonio'),
  colaboradorId: uuid('colaborador_id').references(() => colaboradores.id),
  expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
  usadoEm: timestamp('usado_em', { withTimezone: true }),
  dispositivoId: uuid('dispositivo_id').references(() => dispositivos.id),
  criadoPor: uuid('criado_por')
    .notNull()
    .references(() => usuarios.id),
});
