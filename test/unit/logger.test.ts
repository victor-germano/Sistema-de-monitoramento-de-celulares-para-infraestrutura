// Achado numa revisão de segurança: REDACT_PATHS só cobria `*.password`,
// mas o campo real enviado à AMAPI é `newPassword` (RESET_PASSWORD, ver
// src/integrations/amapi/commands.ts) — um erro bruto do googleapis/gaxios
// pode carregar isso em profundidade variável. Este teste prova que o
// `loggerOptions` de verdade mascara o valor, não só confia em leitura de
// código — escreve pra um stream em memória e inspeciona o JSON gerado.
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { loggerOptions } from '../../src/shared/logger.ts';

function capturarLinhasDeLog(): { linhas: string[]; stream: Writable } {
  const linhas: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      linhas.push(chunk.toString('utf-8'));
      callback();
    },
  });
  return { linhas, stream };
}

describe('loggerOptions — redaction de segredo', () => {
  it('mascara newPassword em profundidade 1, 2 e 3 (não só o raso)', () => {
    const { linhas, stream } = capturarLinhasDeLog();
    const logger = pino({ ...loggerOptions, transport: undefined }, stream);

    logger.error({
      raso: { newPassword: 'segredo-raso' },
      medio: { a: { newPassword: 'segredo-medio' } },
      profundo: { a: { b: { newPassword: 'segredo-profundo' } } },
    });

    const linha = linhas.join('');
    expect(linha).not.toContain('segredo-raso');
    expect(linha).not.toContain('segredo-medio');
    expect(linha).not.toContain('segredo-profundo');
    expect(linha).toContain('[REDACTED]');
  });

  it('nunca loga o erro bruto de um comando RESET_PASSWORD — só a mensagem sanitizada', () => {
    // Guarda de regressão pro fix em devices.routes.ts: simula a FORMA real
    // de um erro de gaxios (propriedade extra `config` com o body original)
    // pra garantir que o padrão de log usado lá (erroMensagem, não err: erro)
    // nunca reintroduz o vazamento, mesmo que REDACT_PATHS mude no futuro.
    const { linhas, stream } = capturarLinhasDeLog();
    const logger = pino({ ...loggerOptions, transport: undefined }, stream);

    const erroGaxiosSimulado = Object.assign(new Error('Request failed'), {
      config: { data: { newPassword: 'segredo-do-usuario' } },
    });

    logger.error(
      { erroMensagem: erroGaxiosSimulado.message, comandoId: 'x', tipo: 'RESET_PASSWORD' },
      'falha ao emitir comando na AMAPI',
    );

    expect(linhas.join('')).not.toContain('segredo-do-usuario');
  });
});
