// Seção 8, item 4: "Adicione watchdog: se não houver mensagem processada em
// N minutos, emitir alerta de saúde." Extraído do consumer pra ser testável
// sem precisar de um Pub/Sub de verdade — só timers.
export interface Watchdog {
  registrarAtividade(): void;
  parar(): void;
}

export function criarWatchdog(
  limiteMinutos: number,
  aoDisparar: (minutosParado: number) => void,
  intervaloVerificacaoMs = 60_000,
): Watchdog {
  let ultimaAtividade = Date.now();

  const timer = setInterval(() => {
    const minutosParado = (Date.now() - ultimaAtividade) / 60_000;
    if (minutosParado > limiteMinutos) {
      aoDisparar(minutosParado);
    }
  }, intervaloVerificacaoMs);
  // `unref()` não existe em todo ambiente (browsers, alguns runtimes de
  // teste) — encadeado com `?.` pra não quebrar onde não existir.
  timer.unref?.();

  return {
    registrarAtividade() {
      ultimaAtividade = Date.now();
    },
    parar() {
      clearInterval(timer);
    },
  };
}
