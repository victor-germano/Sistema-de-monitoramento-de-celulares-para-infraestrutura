import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { criarWatchdog } from '../../src/workers/watchdog.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('criarWatchdog', () => {
  it('não dispara antes do limite', () => {
    const aoDisparar = vi.fn();
    const watchdog = criarWatchdog(15, aoDisparar, 1_000);

    vi.advanceTimersByTime(10 * 60_000); // 10 min < limite de 15
    expect(aoDisparar).not.toHaveBeenCalled();

    watchdog.parar();
  });

  it('dispara quando passa do limite sem nenhuma atividade registrada', () => {
    const aoDisparar = vi.fn();
    const watchdog = criarWatchdog(15, aoDisparar, 1_000);

    vi.advanceTimersByTime(16 * 60_000);
    expect(aoDisparar).toHaveBeenCalled();
    expect(aoDisparar.mock.calls[0]?.[0]).toBeGreaterThan(15);

    watchdog.parar();
  });

  it('registrarAtividade() reseta a contagem — não dispara se a atividade for renovada a tempo', () => {
    const aoDisparar = vi.fn();
    const watchdog = criarWatchdog(15, aoDisparar, 1_000);

    vi.advanceTimersByTime(10 * 60_000);
    watchdog.registrarAtividade();
    vi.advanceTimersByTime(10 * 60_000); // + 10min desde o reset = 10min, ainda < 15

    expect(aoDisparar).not.toHaveBeenCalled();
    watchdog.parar();
  });

  it('parar() interrompe a checagem — nenhum disparo depois disso', () => {
    const aoDisparar = vi.fn();
    const watchdog = criarWatchdog(15, aoDisparar, 1_000);

    watchdog.parar();
    vi.advanceTimersByTime(60 * 60_000);
    expect(aoDisparar).not.toHaveBeenCalled();
  });
});
