import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/env.ts';

// Testa o schema puro (`envSchema.safeParse`), não `env.ts` inteiro — o
// módulo `env.ts` faz `process.exit(1)` em config inválida no import, o que
// derrubaria o worker do Vitest. Ver comentário em `src/config/env.ts`.
describe('envSchema', () => {
  const base = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    OIDC_ISSUER: 'https://accounts.google.com',
    OIDC_CLIENT_ID: 'client-id',
    OIDC_CLIENT_SECRET: 'client-secret',
    OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    FRONTEND_URL: 'http://localhost:5173',
    ALLOWED_EMAIL_DOMAINS: 'gruporoveri.com.br',
    JWT_SECRET: 'segredo-de-teste-com-pelo-menos-32-caracteres',
    AMAPI_ENTERPRISE_NAME: 'enterprises/LC00000000000000000',
    AMAPI_SERVICE_ACCOUNT_KEY_PATH: './secrets/amapi-service-account.json',
    GOOGLE_CLOUD_PROJECT: 'projeto-teste',
    PUBSUB_SUBSCRIPTION: 'subscription-teste',
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

  it('rejeita JWT_SECRET com menos de 32 caracteres', () => {
    const result = envSchema.safeParse({ ...base, JWT_SECRET: 'curto-demais' });
    expect(result.success).toBe(false);
  });

  it('rejeita ALLOWED_EMAIL_DOMAINS vazio — precisa de pelo menos um domínio', () => {
    const result = envSchema.safeParse({ ...base, ALLOWED_EMAIL_DOMAINS: '' });
    expect(result.success).toBe(false);
  });

  it('faz parse de ALLOWED_EMAIL_DOMAINS com múltiplos domínios', () => {
    const result = envSchema.safeParse({
      ...base,
      ALLOWED_EMAIL_DOMAINS: 'gruporoveri.com.br, outraempresa.com.br',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ALLOWED_EMAIL_DOMAINS).toEqual([
        'gruporoveri.com.br',
        'outraempresa.com.br',
      ]);
    }
  });

  it('BOOTSTRAP_ADMIN_EMAILS é opcional e vira lista vazia por default', () => {
    const result = envSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.BOOTSTRAP_ADMIN_EMAILS).toEqual([]);
    }
  });

  it('rejeita AMAPI_ENTERPRISE_NAME fora do formato enterprises/<id>', () => {
    const result = envSchema.safeParse({ ...base, AMAPI_ENTERPRISE_NAME: 'LC00000000000000000' });
    expect(result.success).toBe(false);
  });

  it('rejeita quando GOOGLE_CLOUD_PROJECT ou PUBSUB_SUBSCRIPTION estão ausentes', () => {
    const { GOOGLE_CLOUD_PROJECT: _omit, ...rest } = base;
    expect(envSchema.safeParse(rest).success).toBe(false);
    const { PUBSUB_SUBSCRIPTION: _omit2, ...rest2 } = base;
    expect(envSchema.safeParse(rest2).success).toBe(false);
  });

  it('aplica defaults de JWT_SESSION_TTL_MINUTES e REFRESH_TOKEN_TTL_HOURS', () => {
    const result = envSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.JWT_SESSION_TTL_MINUTES).toBe(15);
      expect(result.data.REFRESH_TOKEN_TTL_HOURS).toBe(8);
    }
  });
});
