import { describe, expect, it, vi } from 'vitest';
import { comRetryEBackoff, ehErroRetentavel } from '../../src/integrations/amapi/retry.ts';

function erroComStatus(status: number): Error & { status: number } {
  return Object.assign(new Error(`erro ${status}`), { status });
}

describe('ehErroRetentavel', () => {
  it.each([429, 500, 502, 503, 599])('trata %i como retentável', (status) => {
    expect(ehErroRetentavel(erroComStatus(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])(
    '4xx que não seja 429 (ex.: %i) NUNCA é retentável — seção 7',
    (status) => {
      expect(ehErroRetentavel(erroComStatus(status))).toBe(false);
    },
  );

  it('erro sem status numérico não é retentável', () => {
    expect(ehErroRetentavel(new Error('sem status'))).toBe(false);
    expect(ehErroRetentavel('string qualquer')).toBe(false);
    expect(ehErroRetentavel(null)).toBe(false);
  });

  it('lê o status de dentro de `response.status` quando não está direto no erro', () => {
    expect(ehErroRetentavel({ response: { status: 503 } })).toBe(true);
  });
});

describe('comRetryEBackoff', () => {
  it('retorna direto no sucesso da primeira tentativa, sem aguardar', async () => {
    const aguardar = vi.fn().mockResolvedValue(undefined);
    const chamar = vi.fn().mockResolvedValue('ok');

    const resultado = await comRetryEBackoff(chamar, { aguardar });

    expect(resultado).toBe('ok');
    expect(chamar).toHaveBeenCalledTimes(1);
    expect(aguardar).not.toHaveBeenCalled();
  });

  it('tenta de novo em erro retentável e devolve o resultado quando a tentativa seguinte funciona', async () => {
    const aguardar = vi.fn().mockResolvedValue(undefined);
    const chamar = vi.fn().mockRejectedValueOnce(erroComStatus(429)).mockResolvedValueOnce('ok');

    const resultado = await comRetryEBackoff(chamar, { aguardar });

    expect(resultado).toBe('ok');
    expect(chamar).toHaveBeenCalledTimes(2);
    expect(aguardar).toHaveBeenCalledTimes(1);
  });

  it('desiste depois do máximo de tentativas e propaga o último erro', async () => {
    const aguardar = vi.fn().mockResolvedValue(undefined);
    const erro = erroComStatus(503);
    const chamar = vi.fn().mockRejectedValue(erro);

    await expect(comRetryEBackoff(chamar, { aguardar, maxTentativas: 3 })).rejects.toBe(erro);
    expect(chamar).toHaveBeenCalledTimes(3);
    expect(aguardar).toHaveBeenCalledTimes(2);
  });

  it('erro NÃO retentável (4xx que não é 429) propaga na primeira falha, sem retry', async () => {
    const aguardar = vi.fn();
    const erro = erroComStatus(400);
    const chamar = vi.fn().mockRejectedValue(erro);

    await expect(comRetryEBackoff(chamar, { aguardar })).rejects.toBe(erro);
    expect(chamar).toHaveBeenCalledTimes(1);
    expect(aguardar).not.toHaveBeenCalled();
  });

  it('backoff dobra a cada tentativa e nunca ultrapassa 50% de jitter', async () => {
    const atrasos: number[] = [];
    const aguardar = vi.fn().mockImplementation((ms: number) => {
      atrasos.push(ms);
      return Promise.resolve();
    });
    const chamar = vi.fn().mockRejectedValue(erroComStatus(500));

    await expect(comRetryEBackoff(chamar, { aguardar, maxTentativas: 4 })).rejects.toBeDefined();

    expect(atrasos).toHaveLength(3);
    // Base sem jitter: 100, 200, 400 — com até 50% de jitter, o teto de
    // cada tentativa é 1.5x a base.
    expect(atrasos[0]).toBeGreaterThanOrEqual(100);
    expect(atrasos[0]).toBeLessThanOrEqual(150);
    expect(atrasos[1]).toBeGreaterThanOrEqual(200);
    expect(atrasos[1]).toBeLessThanOrEqual(300);
    expect(atrasos[2]).toBeGreaterThanOrEqual(400);
    expect(atrasos[2]).toBeLessThanOrEqual(600);
  });

  it('usa o aguardo real (setTimeout) quando nenhum `aguardar` é injetado', async () => {
    vi.useFakeTimers();
    try {
      const chamar = vi.fn().mockRejectedValueOnce(erroComStatus(429)).mockResolvedValueOnce('ok');
      const promessa = comRetryEBackoff(chamar);
      await vi.runAllTimersAsync();
      await expect(promessa).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});
