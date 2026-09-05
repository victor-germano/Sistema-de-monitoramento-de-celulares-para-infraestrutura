import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clienteFake, obterClienteAmapiMock } = vi.hoisted(() => {
  const clienteFake = {
    enterprises: {
      devices: { get: vi.fn(), list: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
  };
  return { clienteFake, obterClienteAmapiMock: vi.fn().mockResolvedValue(clienteFake) };
});

vi.mock('../../src/integrations/amapi/client.ts', () => ({
  obterClienteAmapi: obterClienteAmapiMock,
  nomeEnterprise: () => 'enterprises/LC00000000000000000',
}));

const {
  obterDispositivo,
  listarDispositivos,
  trocarPoliticaDoDispositivo,
  desprovisionarDispositivo,
} = await import('../../src/integrations/amapi/devices.ts');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('devices.ts', () => {
  it('obterDispositivo repassa o name', async () => {
    clienteFake.enterprises.devices.get.mockResolvedValueOnce({ data: { name: 'dev-1' } });
    const dispositivo = await obterDispositivo('enterprises/x/devices/dev-1');
    expect(clienteFake.enterprises.devices.get).toHaveBeenCalledWith({
      name: 'enterprises/x/devices/dev-1',
    });
    expect(dispositivo.name).toBe('dev-1');
  });

  it('listarDispositivos usa a enterprise como parent e devolve o token de próxima página', async () => {
    clienteFake.enterprises.devices.list.mockResolvedValueOnce({
      data: { devices: [{ name: 'dev-1' }], nextPageToken: 'abc' },
    });
    const resultado = await listarDispositivos({ pageSize: 50 });
    expect(clienteFake.enterprises.devices.list).toHaveBeenCalledWith({
      parent: 'enterprises/LC00000000000000000',
      pageSize: 50,
      pageToken: undefined,
    });
    expect(resultado.dispositivos).toHaveLength(1);
    expect(resultado.proximaPagina).toBe('abc');
  });

  it('trocarPoliticaDoDispositivo usa updateMask restrito a policyName — nunca reaplica a política inteira', async () => {
    clienteFake.enterprises.devices.patch.mockResolvedValueOnce({ data: {} });
    await trocarPoliticaDoDispositivo('enterprises/x/devices/dev-1', 'enterprises/x/policies/nova');
    expect(clienteFake.enterprises.devices.patch).toHaveBeenCalledWith({
      name: 'enterprises/x/devices/dev-1',
      updateMask: 'policyName',
      requestBody: { policyName: 'enterprises/x/policies/nova' },
    });
  });

  it('desprovisionarDispositivo repassa wipeDataFlags e wipeReasonMessage pro delete', async () => {
    clienteFake.enterprises.devices.delete.mockResolvedValueOnce({ data: {} });
    await desprovisionarDispositivo('enterprises/x/devices/dev-1', {
      wipeDataFlags: ['WIPE_EXTERNAL_STORAGE'],
      wipeReasonMessage: 'Desligamento do colaborador',
    });
    expect(clienteFake.enterprises.devices.delete).toHaveBeenCalledWith({
      name: 'enterprises/x/devices/dev-1',
      wipeDataFlags: ['WIPE_EXTERNAL_STORAGE'],
      wipeReasonMessage: 'Desligamento do colaborador',
    });
  });
});
