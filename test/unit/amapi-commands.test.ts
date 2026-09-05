import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clienteFake, obterClienteAmapiMock } = vi.hoisted(() => {
  const clienteFake = {
    enterprises: {
      devices: { issueCommand: vi.fn(), delete: vi.fn() },
    },
  };
  return { clienteFake, obterClienteAmapiMock: vi.fn().mockResolvedValue(clienteFake) };
});

vi.mock('../../src/integrations/amapi/client.ts', () => ({
  obterClienteAmapi: obterClienteAmapiMock,
  nomeEnterprise: () => 'enterprises/LC00000000000000000',
}));

const { emitirComando, emitirWipe } = await import('../../src/integrations/amapi/commands.ts');

// Os mocks são compartilhados por TODO o arquivo (`vi.hoisted`) — sem
// limpar entre testes, `mock.calls` acumula chamadas de testes anteriores
// e tanto `.mock.calls[0]` quanto `.not.toHaveBeenCalled()` mentem sobre o
// que o teste ATUAL fez. Achado rodando de verdade, não hipotético.
beforeEach(() => {
  vi.clearAllMocks();
});

describe('commands.ts — emitirComando', () => {
  it('LOCK/REBOOT/RELINQUISH_OWNERSHIP mandam só o type, sem parâmetros extras', async () => {
    clienteFake.enterprises.devices.issueCommand.mockResolvedValueOnce({
      data: { name: 'operations/op-1' },
    });
    const resultado = await emitirComando('enterprises/x/devices/dev-1', 'LOCK');

    expect(clienteFake.enterprises.devices.issueCommand).toHaveBeenCalledWith({
      name: 'enterprises/x/devices/dev-1',
      requestBody: { type: 'LOCK' },
    });
    expect(resultado.nomeOperacao).toBe('operations/op-1');
  });

  it('RESET_PASSWORD inclui newPassword quando fornecida', async () => {
    clienteFake.enterprises.devices.issueCommand.mockResolvedValueOnce({ data: {} });
    await emitirComando('enterprises/x/devices/dev-1', 'RESET_PASSWORD', { novaSenha: '123456' });

    expect(clienteFake.enterprises.devices.issueCommand).toHaveBeenCalledWith({
      name: 'enterprises/x/devices/dev-1',
      requestBody: { type: 'RESET_PASSWORD', newPassword: '123456' },
    });
  });

  it('CLEAR_APP_DATA inclui clearAppsDataParams com os pacotes', async () => {
    clienteFake.enterprises.devices.issueCommand.mockResolvedValueOnce({ data: {} });
    await emitirComando('enterprises/x/devices/dev-1', 'CLEAR_APP_DATA', {
      pacotes: ['com.exemplo.app'],
    });

    expect(clienteFake.enterprises.devices.issueCommand).toHaveBeenCalledWith({
      name: 'enterprises/x/devices/dev-1',
      requestBody: {
        type: 'CLEAR_APP_DATA',
        clearAppsDataParams: { packageNames: ['com.exemplo.app'] },
      },
    });
  });

  it('nomeOperacao fica undefined quando a AMAPI não retorna name', async () => {
    clienteFake.enterprises.devices.issueCommand.mockResolvedValueOnce({ data: {} });
    const resultado = await emitirComando('enterprises/x/devices/dev-1', 'REBOOT');
    expect(resultado.nomeOperacao).toBeUndefined();
  });
});

describe('commands.ts — emitirWipe', () => {
  it('wipe é devices.delete com wipeDataFlags, não um issueCommand', async () => {
    clienteFake.enterprises.devices.delete.mockResolvedValueOnce({ data: {} });
    await emitirWipe('enterprises/x/devices/dev-1', {
      wipeDataFlags: ['WIPE_EXTERNAL_STORAGE'],
      wipeReasonMessage: 'confirmado via dupla confirmação',
    });
    expect(clienteFake.enterprises.devices.delete).toHaveBeenCalledWith({
      name: 'enterprises/x/devices/dev-1',
      wipeDataFlags: ['WIPE_EXTERNAL_STORAGE'],
      wipeReasonMessage: 'confirmado via dupla confirmação',
    });
    expect(clienteFake.enterprises.devices.issueCommand).not.toHaveBeenCalled();
  });
});
