import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type * as RefreshTokensModule from '../../src/domain/auth/refresh-tokens.ts';

let postgresContainer: StartedPostgreSqlContainer;
let criarRefreshToken: typeof RefreshTokensModule.criarRefreshToken;
let rotacionarRefreshToken: typeof RefreshTokensModule.rotacionarRefreshToken;
let revogarRefreshToken: typeof RefreshTokensModule.revogarRefreshToken;
let RefreshTokenInvalidoError: typeof RefreshTokensModule.RefreshTokenInvalidoError;
let usuarioId: string;

beforeAll(async () => {
  postgresContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = postgresContainer.getConnectionUri();
  // Redis não é tocado por nenhuma função testada aqui, mas `env.ts` exige
  // a variável pra dar boot — qualquer URL sintaticamente válida serve,
  // já que o cliente ioredis é lazy e ninguém chama `.ping()` neste teste.
  process.env.REDIS_URL = 'redis://localhost:6379';

  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { db } = await import('../../src/db/client.ts');
  const { usuarios } = await import('../../src/db/schema/usuarios.ts');
  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  const [usuario] = await db
    .insert(usuarios)
    .values({
      oidcSubject: 'oidc-refresh-teste',
      email: 'refresh@gruporoveri.com.br',
      nome: 'Teste Refresh',
    })
    .returning();
  if (!usuario) throw new Error('falha ao semear usuário de teste');
  usuarioId = usuario.id;

  ({ criarRefreshToken, rotacionarRefreshToken, revogarRefreshToken, RefreshTokenInvalidoError } =
    await import('../../src/domain/auth/refresh-tokens.ts'));
}, 60_000);

afterAll(async () => {
  await postgresContainer?.stop();
});

describe('refresh tokens', () => {
  it('token recém-criado rotaciona com sucesso e emite um token diferente', async () => {
    const emitido = await criarRefreshToken(usuarioId);
    const rotacionado = await rotacionarRefreshToken(emitido.token);

    expect(rotacionado.usuarioId).toBe(usuarioId);
    expect(rotacionado.token).not.toBe(emitido.token);
  });

  it('reusar um token já rotacionado falha — é o sinal de token roubado', async () => {
    const emitido = await criarRefreshToken(usuarioId);
    await rotacionarRefreshToken(emitido.token); // primeira rotação, consome o token

    await expect(rotacionarRefreshToken(emitido.token)).rejects.toBeInstanceOf(
      RefreshTokenInvalidoError,
    );
  });

  it('token revogado (logout) não rotaciona mais', async () => {
    const emitido = await criarRefreshToken(usuarioId);
    await revogarRefreshToken(emitido.token);

    await expect(rotacionarRefreshToken(emitido.token)).rejects.toBeInstanceOf(
      RefreshTokenInvalidoError,
    );
  });

  it('revogar um token inexistente/já revogado é idempotente — não lança', async () => {
    await expect(revogarRefreshToken('token-que-nunca-existiu')).resolves.toBeUndefined();
  });

  it('token com valor arbitrário nunca rotaciona', async () => {
    await expect(rotacionarRefreshToken('valor-inventado')).rejects.toBeInstanceOf(
      RefreshTokenInvalidoError,
    );
  });
});
