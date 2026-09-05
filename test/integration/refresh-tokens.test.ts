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

  it('ADR-013: reuso de token já rotacionado revoga TODAS as sessões ativas do usuário', async () => {
    // Duas "sessões" (ex.: dois dispositivos) pro mesmo usuário.
    const sessaoA = await criarRefreshToken(usuarioId);
    const sessaoB = await criarRefreshToken(usuarioId);

    // Sessão A rotaciona normalmente (uso legítimo).
    const sessaoARotacionada = await rotacionarRefreshToken(sessaoA.token);

    // Alguém tenta reusar o token ANTIGO da sessão A — sinal de roubo.
    await expect(rotacionarRefreshToken(sessaoA.token)).rejects.toBeInstanceOf(
      RefreshTokenInvalidoError,
    );

    // Cascata: até a sessão B (nunca reutilizada, totalmente alheia ao
    // ataque) e o token NOVO da sessão A (fruto da rotação legítima) devem
    // ter sido revogados junto — é isso que força login de novo em tudo.
    await expect(rotacionarRefreshToken(sessaoB.token)).rejects.toBeInstanceOf(
      RefreshTokenInvalidoError,
    );
    await expect(rotacionarRefreshToken(sessaoARotacionada.token)).rejects.toBeInstanceOf(
      RefreshTokenInvalidoError,
    );
  });

  it('token só expirado (nunca revogado) NÃO dispara cascata', async () => {
    const { db } = await import('../../src/db/client.ts');
    const { refreshTokens } = await import('../../src/db/schema/refresh-tokens.ts');
    const { eq } = await import('drizzle-orm');
    const { hashToken } = await import('../../src/domain/auth/refresh-tokens.ts');

    // Token de uma "outra sessão" que continua válido — usado depois pra
    // provar que a cascata NÃO alcançou ele.
    const sessaoIrma = await criarRefreshToken(usuarioId);

    // Simula expiração natural: emite um token normalmente e força
    // `expiraEm` pro passado direto no banco (localizado pelo hash — é o
    // único jeito de achar a linha, a tabela nunca guarda o token puro).
    const tokenExpirado = await criarRefreshToken(usuarioId);
    await db
      .update(refreshTokens)
      .set({ expiraEm: new Date(Date.now() - 1000) })
      .where(eq(refreshTokens.tokenHash, hashToken(tokenExpirado.token)));

    // Simplesmente expirado: 401, sem afetar a sessão irmã.
    await expect(rotacionarRefreshToken(tokenExpirado.token)).rejects.toBeInstanceOf(
      RefreshTokenInvalidoError,
    );
    const sessaoIrmaAindaValida = await rotacionarRefreshToken(sessaoIrma.token);
    expect(sessaoIrmaAindaValida.usuarioId).toBe(usuarioId);
  });
});
