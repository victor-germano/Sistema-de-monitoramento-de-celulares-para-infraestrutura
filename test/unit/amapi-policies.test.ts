import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clienteFake, obterClienteAmapiMock } = vi.hoisted(() => {
  const clienteFake = {
    enterprises: {
      policies: {
        get: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
        patch: vi.fn(),
      },
    },
  };
  return { clienteFake, obterClienteAmapiMock: vi.fn().mockResolvedValue(clienteFake) };
});

vi.mock('../../src/integrations/amapi/client.ts', () => ({
  obterClienteAmapi: obterClienteAmapiMock,
  nomeEnterprise: () => 'enterprises/LC00000000000000000',
}));

const { obterPolitica, listarPoliticas, excluirPolitica, salvarPolitica } =
  await import('../../src/integrations/amapi/policies.ts');

// Ver comentário equivalente em amapi-commands.test.ts — mock hoisted é
// compartilhado por todo o arquivo, precisa de reset entre testes.
beforeEach(() => {
  vi.clearAllMocks();
});

describe('policies.ts', () => {
  it('obterPolitica repassa o name e devolve o payload da AMAPI', async () => {
    clienteFake.enterprises.policies.get.mockResolvedValueOnce({ data: { name: 'pol-1' } });
    const politica = await obterPolitica('enterprises/x/policies/pol-1');
    expect(clienteFake.enterprises.policies.get).toHaveBeenCalledWith({
      name: 'enterprises/x/policies/pol-1',
    });
    expect(politica).toEqual({ name: 'pol-1' });
  });

  it('listarPoliticas usa a enterprise como parent e devolve lista vazia se a AMAPI não retornar `policies`', async () => {
    clienteFake.enterprises.policies.list.mockResolvedValueOnce({ data: {} });
    const politicas = await listarPoliticas();
    expect(clienteFake.enterprises.policies.list).toHaveBeenCalledWith({
      parent: 'enterprises/LC00000000000000000',
    });
    expect(politicas).toEqual([]);
  });

  it('excluirPolitica repassa o name pro delete da AMAPI', async () => {
    clienteFake.enterprises.policies.delete.mockResolvedValueOnce({ data: {} });
    await excluirPolitica('enterprises/x/policies/pol-1');
    expect(clienteFake.enterprises.policies.delete).toHaveBeenCalledWith({
      name: 'enterprises/x/policies/pol-1',
    });
  });

  it('salvarPolitica aplica enforceInvariants ANTES de mandar pra AMAPI — bypass no payload de entrada não sobrevive', async () => {
    clienteFake.enterprises.policies.patch.mockResolvedValueOnce({ data: {} });

    await salvarPolitica('enterprises/x/policies/pol-1', {
      uninstallAppsDisabled: false, // tentativa de bypass
      applications: [{ packageName: 'com.a', installType: 'AVAILABLE' }],
    });

    const chamada = clienteFake.enterprises.policies.patch.mock.calls[0]?.[0] as {
      name: string;
      requestBody: {
        uninstallAppsDisabled?: boolean;
        playStoreMode?: string;
        applications?: Array<{ uninstallBlocked?: boolean }>;
      };
    };
    expect(chamada.name).toBe('enterprises/x/policies/pol-1');
    expect(chamada.requestBody.uninstallAppsDisabled).toBe(true);
    expect(chamada.requestBody.playStoreMode).toBe('WHITELIST');
    expect(chamada.requestBody.applications?.[0]?.uninstallBlocked).toBe(true);
  });
});
