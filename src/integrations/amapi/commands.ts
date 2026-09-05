import { obterClienteAmapi } from './client.ts';
import { comRetryEBackoff } from './retry.ts';
import { desprovisionarDispositivo } from './devices.ts';

// Os 4 papéis mapeiam pra 5 tipos de comando reais da AMAPI + wipe (que não
// é um "comando" na API, é `devices.delete` — ver `emitirWipe` abaixo).
// União fechada em vez de `string` solto: bate 1:1 com o enum
// `comando_tipo` do schema (`src/db/schema/comandos.ts`).
export type TipoComandoAmapi =
  'LOCK' | 'REBOOT' | 'RESET_PASSWORD' | 'RELINQUISH_OWNERSHIP' | 'CLEAR_APP_DATA';

export interface EmitirComandoOpcoes {
  /** Só usado em RESET_PASSWORD. */
  novaSenha?: string;
  /** Só usado em CLEAR_APP_DATA — nomes de pacote a limpar. */
  pacotes?: string[];
}

export interface ComandoEmitido {
  /** Nome da operação assíncrona da AMAPI — é o que vira `comandos.amapi_operation_name`. */
  nomeOperacao: string | undefined;
}

/**
 * `devices.issueCommand` devolve uma `Operation` (long-running) — não o
 * resultado final. O status real do comando chega depois via evento
 * `COMMAND` do Pub/Sub (seção 8, Fase 4), que atualiza `comandos.status`
 * usando `nomeOperacao` pra achar a linha certa.
 */
export async function emitirComando(
  nomeDispositivo: string,
  tipo: TipoComandoAmapi,
  opcoes: EmitirComandoOpcoes = {},
): Promise<ComandoEmitido> {
  const cliente = await obterClienteAmapi();

  const resposta = await comRetryEBackoff(() =>
    cliente.enterprises.devices.issueCommand({
      name: nomeDispositivo,
      requestBody: {
        type: tipo,
        ...(tipo === 'RESET_PASSWORD' && opcoes.novaSenha ? { newPassword: opcoes.novaSenha } : {}),
        ...(tipo === 'CLEAR_APP_DATA' && opcoes.pacotes
          ? { clearAppsDataParams: { packageNames: opcoes.pacotes } }
          : {}),
      },
    }),
  );

  return { nomeOperacao: resposta.data.name ?? undefined };
}

export interface EmitirWipeOpcoes {
  wipeDataFlags?: string[];
  wipeReasonMessage?: string;
}

/**
 * Wipe não é um `issueCommand` — é `devices.delete` com `wipeDataFlags`
 * (seção 7). A dupla confirmação (patrimônio digitado + motivo ≥ 20
 * caracteres) é responsabilidade da ROTA (Fase 5), não deste adapter — aqui
 * só a chamada à AMAPI depois que a confirmação já passou.
 */
export async function emitirWipe(
  nomeDispositivo: string,
  opcoes: EmitirWipeOpcoes = {},
): Promise<void> {
  await desprovisionarDispositivo(nomeDispositivo, opcoes);
}
