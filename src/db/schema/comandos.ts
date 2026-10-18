import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidPk } from './_shared.ts';
import { dispositivos } from './dispositivos.ts';
import { usuarios } from './usuarios.ts';

// `tipo` e `status` são categorias que O NOSSO sistema origina e controla —
// só nós decidimos qual comando emitir e só nós transicionamos o status.
// Diferente de `dispositivos.estado`/`compliance_state` (observados da
// AMAPI), aqui um valor fora do enum É um bug nosso. Ver ADR-007.
export const comandoTipoEnum = pgEnum('comando_tipo', [
  'LOCK',
  'REBOOT',
  'RESET_PASSWORD',
  'RELINQUISH_OWNERSHIP',
  'CLEAR_APP_DATA',
  'WIPE',
]);

export const comandoStatusEnum = pgEnum('comando_status', [
  'PENDENTE',
  'ENVIADO',
  'SUCESSO',
  'FALHA',
]);

export const comandos = pgTable(
  'comandos',
  {
    id: uuidPk(),
    dispositivoId: uuid('dispositivo_id')
      .notNull()
      .references(() => dispositivos.id),
    tipo: comandoTipoEnum('tipo').notNull(),
    payload: jsonb('payload'),
    amapiOperationName: text('amapi_operation_name'),
    status: comandoStatusEnum('status').notNull().default('PENDENTE'),
    erro: text('erro'),
    solicitadoPor: uuid('solicitado_por')
      .notNull()
      .references(() => usuarios.id),
    solicitadoEm: timestamp('solicitado_em', { withTimezone: true }).notNull().defaultNow(),
    concluidoEm: timestamp('concluido_em', { withTimezone: true }),
  },
  (t) => [
    // Achado numa auditoria de performance: `GET /devices/:id/comandos`
    // (aba "Comandos" da tela de detalhe, visitada toda vez que alguém abre
    // um dispositivo) filtrava por esta coluna sem índice nenhum na tabela.
    index('comandos_dispositivo_id_idx').on(t.dispositivoId),
  ],
);
