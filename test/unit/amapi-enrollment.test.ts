import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clienteFake, obterClienteAmapiMock } = vi.hoisted(() => {
  const clienteFake = {
    enterprises: {
      enrollmentTokens: { create: vi.fn(), delete: vi.fn() },
    },
  };
  return { clienteFake, obterClienteAmapiMock: vi.fn().mockResolvedValue(clienteFake) };
});

vi.mock('../../src/integrations/amapi/client.ts', () => ({
  obterClienteAmapi: obterClienteAmapiMock,
  nomeEnterprise: () => 'enterprises/LC00000000000000000',
}));

const { criarEnrollmentToken, revogarEnrollmentToken } =
  await import('../../src/integrations/amapi/enrollment.ts');

interface ChamadaCreate {
  parent: string;
  requestBody: {
    oneTimeOnly?: boolean;
    allowPersonalUsage?: string;
    additionalData?: string;
    duration?: string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enrollment.ts', () => {
  it('serializa additionalData em JSON e força oneTimeOnly/allowPersonalUsage', async () => {
    clienteFake.enterprises.enrollmentTokens.create.mockResolvedValueOnce({
      data: {
        name: 'enterprises/x/enrollmentTokens/tok-1',
        value: 'valor-secreto',
        qrCode: 'data:image/png;base64,...',
        expirationTimestamp: '2026-01-01T00:00:00Z',
      },
    });

    const resultado = await criarEnrollmentToken({
      nomePolitica: 'enterprises/x/policies/operacao-campo',
      additionalData: { tokenId: 'uuid-interno', patrimonio: 'PAT-123', colaboradorId: 'col-1' },
    });

    const chamada = clienteFake.enterprises.enrollmentTokens.create.mock
      .calls[0]?.[0] as ChamadaCreate;
    expect(chamada.parent).toBe('enterprises/LC00000000000000000');
    expect(chamada.requestBody.oneTimeOnly).toBe(true);
    expect(chamada.requestBody.allowPersonalUsage).toBe('PERSONAL_USAGE_DISALLOWED');
    expect(JSON.parse(chamada.requestBody.additionalData ?? '{}')).toEqual({
      tokenId: 'uuid-interno',
      patrimonio: 'PAT-123',
      colaboradorId: 'col-1',
    });
    // Duração é google.protobuf.Duration (segundos + sufixo `s`), nunca ms puro — ADR-002.
    expect(chamada.requestBody.duration).toMatch(/^\d+s$/);

    expect(resultado.valor).toBe('valor-secreto');
    expect(resultado.qrCode).toBe('data:image/png;base64,...');
    expect(resultado.expiraEm).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('duracaoSegundos customizada é formatada corretamente', async () => {
    clienteFake.enterprises.enrollmentTokens.create.mockResolvedValueOnce({ data: {} });
    await criarEnrollmentToken({
      nomePolitica: 'enterprises/x/policies/p',
      additionalData: { tokenId: 'uuid' },
      duracaoSegundos: 1800,
    });
    const chamada = clienteFake.enterprises.enrollmentTokens.create.mock
      .calls[0]?.[0] as ChamadaCreate;
    expect(chamada.requestBody.duration).toBe('1800s');
  });

  it('campos ausentes na resposta da AMAPI viram undefined, não erro', async () => {
    clienteFake.enterprises.enrollmentTokens.create.mockResolvedValueOnce({ data: {} });
    const resultado = await criarEnrollmentToken({
      nomePolitica: 'enterprises/x/policies/p',
      additionalData: { tokenId: 'uuid' },
    });
    expect(resultado).toEqual({
      nomeRecurso: undefined,
      valor: undefined,
      qrCode: undefined,
      expiraEm: undefined,
    });
  });

  it('revogarEnrollmentToken repassa o name pro delete', async () => {
    clienteFake.enterprises.enrollmentTokens.delete.mockResolvedValueOnce({ data: {} });
    await revogarEnrollmentToken('enterprises/x/enrollmentTokens/tok-1');
    expect(clienteFake.enterprises.enrollmentTokens.delete).toHaveBeenCalledWith({
      name: 'enterprises/x/enrollmentTokens/tok-1',
    });
  });
});
