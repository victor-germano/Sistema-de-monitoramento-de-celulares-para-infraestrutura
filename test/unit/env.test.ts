import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/env.js';

// Testa o schema puro (`envSchema.safeParse`), não `env.ts` inteiro — o
// módulo `env.ts` faz `process.exit(1)` em config inválida no import, o que
// derrubaria o worker do Vitest. Ver comentário em `src/config/env.ts`.
describe('envSchema', () => {
  const base = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('aceita a configuração mínima válida e aplica os defaults', () => {
    const result = envSchema.safeParse(base);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe('development');
      expect(result.data.PORT).toBe(3000);
      expect(result.data.LOG_LEVEL).toBe('info');
      expect(result.data.ALLOWED_ORIGINS).toEqual([]);
    }
  });

  it('rejeita quando DATABASE_URL está ausente', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    const result = envSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejeita DATABASE_URL que não é uma URL válida', () => {
    const result = envSchema.safeParse({ ...base, DATABASE_URL: 'nao-e-uma-url' });
    expect(result.success).toBe(false);
  });

  it('rejeita NODE_ENV fora do enum permitido', () => {
    const result = envSchema.safeParse({ ...base, NODE_ENV: 'staging' });
    expect(result.success).toBe(false);
  });

  it('faz parse e trim de ALLOWED_ORIGINS separado por vírgula', () => {
    const result = envSchema.safeParse({
      ...base,
      ALLOWED_ORIGINS: 'https://a.com, https://b.com ,,https://c.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ALLOWED_ORIGINS).toEqual([
        'https://a.com',
        'https://b.com',
        'https://c.com',
      ]);
    }
  });

  it('coage PORT vindo de string (como process.env sempre entrega)', () => {
    const result = envSchema.safeParse({ ...base, PORT: '4000' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(4000);
    }
  });
});
