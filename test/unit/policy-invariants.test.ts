import { describe, expect, it } from 'vitest';
import {
  aplicarInvariantesComAuditoria,
  enforceInvariants,
  type AppPolicy,
} from '../../src/domain/policy/policy-invariants.ts';

// Cobertura de 100% exigida pela seção 14 da spec para este arquivo — os
// casos abaixo cobrem cada ramo de decisão deliberadamente, incluindo
// tentativas de bypass e um payload simulando rollback de versão antiga
// (seção 3: "Cubra com testes unitários exaustivos, incluindo tentativa
// deliberada de bypass e política vinda de rollback de versão antiga").

describe('enforceInvariants — nível de política', () => {
  it('payload já compliant não gera nenhum override', () => {
    const payload = {
      uninstallAppsDisabled: true,
      installAppsDisabled: false,
      playStoreMode: 'WHITELIST',
      installUnknownSourcesAllowed: false,
      applications: [],
    };
    const { overrides } = aplicarInvariantesComAuditoria(payload);
    expect(overrides).toEqual([]);
  });

  it('bypass: uninstallAppsDisabled: false é sobrescrito para true', () => {
    const { policy, overrides } = aplicarInvariantesComAuditoria({
      uninstallAppsDisabled: false,
    });
    expect(policy.uninstallAppsDisabled).toBe(true);
    expect(overrides).toContainEqual({
      campo: 'uninstallAppsDisabled',
      valorRecebido: false,
      valorForcado: true,
    });
  });

  it('bypass: installAppsDisabled: true é sobrescrito para false', () => {
    const { policy, overrides } = aplicarInvariantesComAuditoria({ installAppsDisabled: true });
    expect(policy.installAppsDisabled).toBe(false);
    expect(overrides).toContainEqual({
      campo: 'installAppsDisabled',
      valorRecebido: true,
      valorForcado: false,
    });
  });

  it('bypass: playStoreMode diferente de WHITELIST é sobrescrito', () => {
    const { policy, overrides } = aplicarInvariantesComAuditoria({ playStoreMode: 'BLACKLIST' });
    expect(policy.playStoreMode).toBe('WHITELIST');
    expect(overrides.some((o) => o.campo === 'playStoreMode')).toBe(true);
  });

  it('bypass: installUnknownSourcesAllowed: true é sobrescrito para false', () => {
    const { policy, overrides } = aplicarInvariantesComAuditoria({
      installUnknownSourcesAllowed: true,
    });
    expect(policy.installUnknownSourcesAllowed).toBe(false);
    expect(overrides.some((o) => o.campo === 'installUnknownSourcesAllowed')).toBe(true);
  });

  it('campos ausentes (undefined) também contam como override, não só valores explicitamente errados', () => {
    const { overrides } = aplicarInvariantesComAuditoria({});
    const campos = overrides.map((o) => o.campo);
    expect(campos).toEqual(
      expect.arrayContaining([
        'uninstallAppsDisabled',
        'installAppsDisabled',
        'playStoreMode',
        'installUnknownSourcesAllowed',
      ]),
    );
  });
});

describe('enforceInvariants — nível de app', () => {
  it('installType permitido (FORCE_INSTALLED/AVAILABLE/PREINSTALLED) é preservado', () => {
    const { policy, overrides } = aplicarInvariantesComAuditoria({
      applications: [
        { packageName: 'com.a', installType: 'FORCE_INSTALLED' },
        { packageName: 'com.b', installType: 'AVAILABLE' },
        { packageName: 'com.c', installType: 'PREINSTALLED' },
      ],
    });
    expect(policy.applications?.map((a) => a.installType)).toEqual([
      'FORCE_INSTALLED',
      'AVAILABLE',
      'PREINSTALLED',
    ]);
    expect(overrides.some((o) => o.campo.includes('installType'))).toBe(false);
  });

  it('installType BLOCKED explícito no payload é preservado (app em lista de bloqueio)', () => {
    const { policy, overrides } = aplicarInvariantesComAuditoria({
      applications: [{ packageName: 'com.malware', installType: 'BLOCKED' }],
    });
    expect(policy.applications?.[0]?.installType).toBe('BLOCKED');
    expect(overrides.some((o) => o.campo === 'applications[0].installType')).toBe(false);
  });

  it('bypass: installType desconhecido/inválido (não permitido, não BLOCKED) vira FORCE_INSTALLED', () => {
    const { policy, overrides } = aplicarInvariantesComAuditoria({
      applications: [{ packageName: 'com.suspeito', installType: 'REQUIRED_FOR_SETUP' }],
    });
    expect(policy.applications?.[0]?.installType).toBe('FORCE_INSTALLED');
    expect(overrides).toContainEqual({
      campo: 'applications[0].installType',
      valorRecebido: 'REQUIRED_FOR_SETUP',
      valorForcado: 'FORCE_INSTALLED',
    });
  });

  it('bypass: installType ausente vira FORCE_INSTALLED', () => {
    const { policy } = aplicarInvariantesComAuditoria({
      applications: [{ packageName: 'com.sem-tipo' }],
    });
    expect(policy.applications?.[0]?.installType).toBe('FORCE_INSTALLED');
  });

  it('todo app recebe uninstallBlocked: true, sem exceção — inclusive os já BLOCKED (ADR-015)', () => {
    const { policy } = aplicarInvariantesComAuditoria({
      applications: [
        { packageName: 'com.a', installType: 'AVAILABLE' },
        { packageName: 'com.bloqueado', installType: 'BLOCKED' },
      ],
    });
    for (const app of policy.applications ?? []) {
      expect((app as { uninstallBlocked?: boolean }).uninstallBlocked).toBe(true);
    }
  });

  it('bypass: uninstallBlocked: false vindo no payload (política de rollback antiga) é sobrescrito', () => {
    // Simula uma política restaurada de uma versão antiga que já trazia o
    // campo (hoje inexistente na AMAPI, mas pode existir em snapshots
    // salvos antes desta correção) tentando desligar a proteção.
    const apps: AppPolicy[] = [
      { packageName: 'com.antigo', installType: 'FORCE_INSTALLED', uninstallBlocked: false },
    ];
    const { policy, overrides } = aplicarInvariantesComAuditoria({ applications: apps });
    expect((policy.applications?.[0] as { uninstallBlocked?: boolean }).uninstallBlocked).toBe(
      true,
    );
    expect(overrides).toContainEqual({
      campo: 'applications[0].uninstallBlocked',
      valorRecebido: false,
      valorForcado: true,
    });
  });

  it('app já com uninstallBlocked: true não gera override duplicado pra esse campo', () => {
    const apps: AppPolicy[] = [
      { packageName: 'com.ok', installType: 'FORCE_INSTALLED', uninstallBlocked: true },
    ];
    const { overrides } = aplicarInvariantesComAuditoria({ applications: apps });
    expect(overrides.some((o) => o.campo === 'applications[0].uninstallBlocked')).toBe(false);
  });

  it('política sem applications (undefined) não quebra e vira lista vazia', () => {
    const { policy } = aplicarInvariantesComAuditoria({});
    expect(policy.applications).toEqual([]);
  });

  it('múltiplos apps são corrigidos independentemente, com índice correto em cada override', () => {
    const apps: AppPolicy[] = [
      { packageName: 'com.ok', installType: 'FORCE_INSTALLED', uninstallBlocked: true },
      { packageName: 'com.ruim', installType: 'ALGO_INVALIDO' },
    ];
    const { overrides } = aplicarInvariantesComAuditoria({ applications: apps });
    expect(overrides.some((o) => o.campo === 'applications[1].installType')).toBe(true);
    expect(overrides.some((o) => o.campo === 'applications[1].uninstallBlocked')).toBe(true);
    expect(overrides.some((o) => o.campo.startsWith('applications[0]'))).toBe(false);
  });
});

describe('enforceInvariants — assinatura pública exigida pela seção 3', () => {
  it('retorna só o payload corrigido, equivalente ao .policy de aplicarInvariantesComAuditoria', () => {
    const payload = { uninstallAppsDisabled: false, applications: [{ packageName: 'com.a' }] };
    expect(enforceInvariants(payload)).toEqual(aplicarInvariantesComAuditoria(payload).policy);
  });

  it('não expõe nenhum parâmetro de bypass — a assinatura só aceita o payload', () => {
    expect(enforceInvariants.length).toBe(1);
  });
});
