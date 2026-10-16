// Achado numa revisão: o nome do arquivo de GET /dashboard/export usava
// `new Date().toISOString()` (sempre UTC) — entre 21h00 e 23h59 no horário
// do Grupo Roveri (America/Sao_Paulo, UTC-3), já é o dia seguinte em UTC, e
// o arquivo baixado vinha com a data de amanhã no nome. Este teste fixa o
// relógio num instante que prova a diferença: ainda é um dia em UTC, já é
// outro no fuso da empresa.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataDeHojeNoFusoDaEmpresa } from '../../src/modules/dashboard/dashboard.routes.ts';

describe('dataDeHojeNoFusoDaEmpresa', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('usa o dia do horário do Brasil, não o dia já virado em UTC', () => {
    // 2026-01-02T02:00:00Z = 2026-01-01T23:00:00-03:00 — em UTC já é dia 2,
    // no horário do Brasil ainda é dia 1.
    vi.setSystemTime(new Date('2026-01-02T02:00:00Z'));
    expect(dataDeHojeNoFusoDaEmpresa()).toBe('2026-01-01');
  });

  it('bate com UTC quando não há diferença de dia entre os dois fusos', () => {
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    expect(dataDeHojeNoFusoDaEmpresa()).toBe('2026-06-15');
  });
});
