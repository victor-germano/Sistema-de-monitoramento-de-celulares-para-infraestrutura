// `ehExecutadoDiretamente` decide se um worker dedicado (`src/workers/*.ts`)
// deve de fato iniciar quando o arquivo roda como processo próprio — achado
// testando a tela de políticas do frontend contra o backend real: o worker
// de escrita de política (`npm run worker:policy-write`) subia sem erro
// nenhum no Windows, mas nunca processava um job sequer. Causa raiz: a
// comparação antiga (`import.meta.url === 'file://' + process.argv[1]`)
// nunca bate no Windows. Simula os dois formatos de path explicitamente
// (não depende do SO rodando o teste) pra cobrir o caso que quebrava.
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ehExecutadoDiretamente } from '../../src/shared/entrypoint.ts';

describe('ehExecutadoDiretamente', () => {
  it('reconhece execução direta com path estilo Windows (barra invertida)', () => {
    const argv1 = 'C:\\Users\\vgerm\\projeto\\src\\workers\\policy-write-worker.ts';
    const moduleUrl = pathToFileURL(argv1).href;
    expect(ehExecutadoDiretamente(moduleUrl, argv1)).toBe(true);
  });

  it('reconhece execução direta com path estilo POSIX (barra normal)', () => {
    const argv1 = '/home/victor/projeto/src/workers/policy-write-worker.ts';
    const moduleUrl = pathToFileURL(argv1).href;
    expect(ehExecutadoDiretamente(moduleUrl, argv1)).toBe(true);
  });

  it('retorna false quando o módulo foi importado (não é o entrypoint), não quando o processo', () => {
    const argv1 = 'C:\\Users\\vgerm\\node_modules\\.bin\\vitest';
    const moduleUrl = pathToFileURL(
      'C:\\Users\\vgerm\\projeto\\src\\workers\\policy-write-worker.ts',
    ).href;
    expect(ehExecutadoDiretamente(moduleUrl, argv1)).toBe(false);
  });

  it('retorna false sem argv1 (ex.: REPL)', () => {
    expect(ehExecutadoDiretamente('file:///C:/projeto/arquivo.ts', undefined)).toBe(false);
  });

  it('documenta a regressão: a comparação literal antiga nunca batia no Windows', () => {
    const argv1 = 'C:\\Users\\vgerm\\projeto\\src\\workers\\policy-write-worker.ts';
    const moduleUrl = pathToFileURL(argv1).href;
    const comparacaoLiteralAntiga = `file://${argv1}`;
    expect(comparacaoLiteralAntiga).not.toBe(moduleUrl);
  });
});
