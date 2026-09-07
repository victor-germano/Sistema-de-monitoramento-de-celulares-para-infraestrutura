import { describe, expect, it } from 'vitest';
import type { androidmanagement_v1 } from 'googleapis';
import {
  formatarMaximumTimeToLockMs,
  formatarDuracaoEmSegundos,
  mapearCamposDispositivo,
  mapearAppsDoDispositivo,
} from '../../src/integrations/amapi/mappers.ts';

type Device = androidmanagement_v1.Schema$Device;

describe('formatarMaximumTimeToLockMs (ADR-002)', () => {
  it('formata milissegundos como string SEM sufixo', () => {
    expect(formatarMaximumTimeToLockMs(600_000)).toBe('600000');
  });

  it('trunca valores fracionários', () => {
    expect(formatarMaximumTimeToLockMs(1500.7)).toBe('1500');
  });
});

describe('formatarDuracaoEmSegundos (ADR-002)', () => {
  it('formata segundos com sufixo "s"', () => {
    expect(formatarDuracaoEmSegundos(1_209_600)).toBe('1209600s');
  });

  it('trunca valores fracionários', () => {
    expect(formatarDuracaoEmSegundos(90.9)).toBe('90s');
  });
});

describe('mapearCamposDispositivo (ADR-019)', () => {
  it('mapeia todos os campos simples de um Device completo', () => {
    const device: Device = {
      networkInfo: { imei: '123456789012345' },
      hardwareInfo: { serialNumber: 'SN-1', manufacturer: 'Motorola', model: 'Moto G' },
      softwareInfo: { androidVersion: '13', securityPatchLevel: '2026-08-01' },
      state: 'ACTIVE',
      policyCompliant: true,
      memoryInfo: { totalInternalStorage: String(64 * 1024 * 1024) },
      lastStatusReportTime: '2026-09-01T10:00:00Z',
    };

    const campos = mapearCamposDispositivo(device);

    expect(campos).toEqual({
      imei: '123456789012345',
      serial: 'SN-1',
      fabricante: 'Motorola',
      modelo: 'Moto G',
      versaoSo: '13',
      patchSeguranca: '2026-08-01',
      estado: 'ACTIVE',
      complianceState: 'COMPLIANT',
      policyCompliant: true,
      bateriaPct: undefined,
      storageTotalMb: 64,
      storageLivreMb: undefined,
      ultimoCheckin: new Date('2026-09-01T10:00:00Z'),
    });
  });

  it('device vazio mapeia tudo pra undefined, sem lançar', () => {
    const campos = mapearCamposDispositivo({});
    expect(campos).toEqual({
      imei: undefined,
      serial: undefined,
      fabricante: undefined,
      modelo: undefined,
      versaoSo: undefined,
      patchSeguranca: undefined,
      estado: undefined,
      complianceState: undefined,
      policyCompliant: undefined,
      bateriaPct: undefined,
      storageTotalMb: undefined,
      storageLivreMb: undefined,
      ultimoCheckin: undefined,
    });
  });

  it('policyCompliant false -> complianceState NON_COMPLIANT', () => {
    expect(mapearCamposDispositivo({ policyCompliant: false }).complianceState).toBe(
      'NON_COMPLIANT',
    );
  });

  it('memoryInfo.totalInternalStorage não numérico não quebra — vira undefined', () => {
    expect(
      mapearCamposDispositivo({ memoryInfo: { totalInternalStorage: 'não-é-um-número' } })
        .storageTotalMb,
    ).toBeUndefined();
  });

  it('extrai a bateria do evento de powerManagementEvents mais recente por createTime', () => {
    const device: Device = {
      powerManagementEvents: [
        { batteryLevel: 50, createTime: '2026-09-01T08:00:00Z' },
        { batteryLevel: 80, createTime: '2026-09-01T12:00:00Z' },
        { batteryLevel: 30, createTime: '2026-09-01T10:00:00Z' },
      ],
    };
    expect(mapearCamposDispositivo(device).bateriaPct).toBe(80);
  });

  it('ignora eventos de powerManagementEvents sem batteryLevel ou sem createTime', () => {
    const device: Device = {
      powerManagementEvents: [
        { createTime: '2026-09-01T08:00:00Z' }, // sem batteryLevel
        { batteryLevel: 42 }, // sem createTime
      ],
    };
    expect(mapearCamposDispositivo(device).bateriaPct).toBeUndefined();
  });

  it('extrai storage livre do evento de memoryEvents mais recente cujo eventType contém STORAGE', () => {
    const device: Device = {
      memoryEvents: [
        {
          eventType: 'INTERNAL_STORAGE_MEASURED',
          byteCount: String(10 * 1024 * 1024),
          createTime: '2026-09-01T08:00:00Z',
        },
        {
          eventType: 'INTERNAL_STORAGE_MEASURED',
          byteCount: String(20 * 1024 * 1024),
          createTime: '2026-09-01T12:00:00Z',
        },
        {
          eventType: 'RAM_MEASURED',
          byteCount: String(999 * 1024 * 1024),
          createTime: '2026-09-01T13:00:00Z',
        },
      ],
    };
    expect(mapearCamposDispositivo(device).storageLivreMb).toBe(20);
  });

  it('memoryEvents sem nenhum eventType de storage -> storageLivreMb undefined', () => {
    const device: Device = {
      memoryEvents: [
        { eventType: 'RAM_MEASURED', byteCount: '123', createTime: '2026-09-01T08:00:00Z' },
      ],
    };
    expect(mapearCamposDispositivo(device).storageLivreMb).toBeUndefined();
  });
});

describe('mapearAppsDoDispositivo (ADR-019)', () => {
  const coletadoEm = new Date('2026-09-01T10:00:00Z');

  it('mapeia relatórios com packageName', () => {
    const relatorios: androidmanagement_v1.Schema$ApplicationReport[] = [
      {
        packageName: 'com.empresa.app',
        displayName: 'App Corp',
        versionName: '1.2.3',
        state: 'INSTALLED',
      },
    ];
    expect(mapearAppsDoDispositivo(relatorios, coletadoEm)).toEqual([
      {
        packageName: 'com.empresa.app',
        nomeExibicao: 'App Corp',
        versao: '1.2.3',
        estado: 'INSTALLED',
        coletadoEm,
      },
    ]);
  });

  it('descarta relatórios sem packageName', () => {
    const relatorios: androidmanagement_v1.Schema$ApplicationReport[] = [
      { displayName: 'Sem pacote' },
      { packageName: 'com.empresa.app2' },
    ];
    const resultado = mapearAppsDoDispositivo(relatorios, coletadoEm);
    expect(resultado).toHaveLength(1);
    expect(resultado[0]?.packageName).toBe('com.empresa.app2');
  });

  it('lista vazia mapeia pra lista vazia', () => {
    expect(mapearAppsDoDispositivo([], coletadoEm)).toEqual([]);
  });
});
