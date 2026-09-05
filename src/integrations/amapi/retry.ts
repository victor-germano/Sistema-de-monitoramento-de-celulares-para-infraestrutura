// Seção 7: "Retry com backoff exponencial + jitter para 429 e 5xx, máximo 5
// tentativas. 4xx que não seja 429 nunca é retentado." — um 400 (payload
// inválido) ou 403 (permissão) nunca vai se resolver tentando de novo; só
// 429 (rate limit) e 5xx (instabilidade transitória do lado do Google) são.
export interface RetryOptions {
  maxTentativas?: number;
  /** Seam de teste — evita esperar de verdade em `npm test`. */
  aguardar?: (ms: number) => Promise<void>;
}

function aguardarDeVerdade(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusHttpDoErro(erro: unknown): number | undefined {
  if (typeof erro !== 'object' || erro === null) return undefined;
  const comStatus = erro as { status?: unknown; response?: { status?: unknown } };
  if (typeof comStatus.status === 'number') return comStatus.status;
  if (typeof comStatus.response?.status === 'number') return comStatus.response.status;
  return undefined;
}

export function ehErroRetentavel(erro: unknown): boolean {
  const status = statusHttpDoErro(erro);
  if (status === undefined) return false;
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Backoff exponencial: 100ms, 200ms, 400ms, 800ms, 1600ms (antes do jitter)
 * — dobra a cada tentativa. Jitter de até 50% pra cima evita que múltiplas
 * instâncias da API, todas rate-limitadas ao mesmo tempo, sincronizem o
 * retry e batam na AMAPI de novo no mesmo instante ("thundering herd").
 */
export async function comRetryEBackoff<T>(
  chamar: () => Promise<T>,
  opcoes: RetryOptions = {},
): Promise<T> {
  const maxTentativas = opcoes.maxTentativas ?? 5;
  const aguardar = opcoes.aguardar ?? aguardarDeVerdade;

  let tentativa = 0;
  for (;;) {
    try {
      return await chamar();
    } catch (erro) {
      tentativa += 1;
      if (tentativa >= maxTentativas || !ehErroRetentavel(erro)) {
        throw erro;
      }
      const backoffMs = 100 * 2 ** (tentativa - 1);
      const jitterMs = Math.random() * backoffMs * 0.5;
      await aguardar(backoffMs + jitterMs);
    }
  }
}
