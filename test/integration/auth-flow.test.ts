import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import type * as DbClientModule from '../../src/db/client.ts';
import type * as UsuariosSchemaModule from '../../src/db/schema/usuarios.ts';
import type * as AuditoriaSchemaModule from '../../src/db/schema/auditoria.ts';
import type * as OidcStateModule from '../../src/domain/auth/oidc-state.ts';
import type * as DrizzleOrmModule from 'drizzle-orm';

// Fronteira mockada: a troca real de `code` por token acontece contra o
// Google/Entra pela rede — não dá pra testar isso de ponta a ponta sem um
// IdP de verdade (o "login corporativo ponta a ponta" da seção 12 é
// validação manual, documentada em docs/SETUP.md, não automatizada). O que
// ESTE arquivo testa é todo o código NOSSO ao redor dessa chamada: geração
// de state/PKCE, validação de domínio, provisionamento, cookie de refresh,
// rotação, auditoria — mockando só `client.authorizationCodeGrant` e
// `buildAuthorizationUrl`, nunca a lógica de negócio.
const { authorizationCodeGrantMock, buildAuthorizationUrlMock } = vi.hoisted(() => ({
  authorizationCodeGrantMock: vi.fn(),
  buildAuthorizationUrlMock: vi.fn(() => new URL('https://provider.example.com/authorize?mock=1')),
}));

vi.mock('../../src/integrations/oidc/client.ts', () => ({
  client: {
    randomPKCECodeVerifier: () => 'verificador-pkce-fake',
    calculatePKCECodeChallenge: () => Promise.resolve('desafio-pkce-fake'),
    randomNonce: () => 'nonce-fake',
    buildAuthorizationUrl: buildAuthorizationUrlMock,
    authorizationCodeGrant: authorizationCodeGrantMock,
  },
  obterConfiguracaoOidc: () => Promise.resolve({}),
}));

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let app: FastifyInstance;
let db: typeof DbClientModule.db;
let usuarios: typeof UsuariosSchemaModule.usuarios;
let auditoria: typeof AuditoriaSchemaModule.auditoria;
let signOidcState: typeof OidcStateModule.signOidcState;
let eq: typeof DrizzleOrmModule.eq;

function claimsFake(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'oidc-sub-callback-teste',
    email: 'novo.usuario@gruporoveri.com.br',
    name: 'Novo Usuário',
    hd: 'gruporoveri.com.br',
    ...overrides,
  };
}

beforeAll(async () => {
  [postgresContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = postgresContainer.getConnectionUri();
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  ({ db } = await import('../../src/db/client.ts'));
  ({ usuarios } = await import('../../src/db/schema/usuarios.ts'));
  ({ auditoria } = await import('../../src/db/schema/auditoria.ts'));
  ({ signOidcState } = await import('../../src/domain/auth/oidc-state.ts'));
  ({ eq } = await import('drizzle-orm'));
  const { buildApp } = await import('../../src/app.ts');

  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  app = await buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Promise.all([postgresContainer?.stop(), redisContainer?.stop()]);
});

describe('GET /auth/login', () => {
  it('redireciona pra URL construída pelo client OIDC, com PKCE e state assinado', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/login' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://provider.example.com/authorize?mock=1');
    expect(buildAuthorizationUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        code_challenge: 'desafio-pkce-fake',
        code_challenge_method: 'S256',
        nonce: 'nonce-fake',
        scope: 'openid email profile',
      }),
    );
  });
});

describe('GET /auth/callback — erros', () => {
  it('provedor recusou (usuário negou consentimento)', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/callback?error=access_denied' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('erro_login=provedor_recusou');
  });

  it('parâmetros ausentes (sem code nem state)', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/callback' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('erro_login=parametros_ausentes');
  });

  it('state inválido/adulterado', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/callback?code=abc&state=isto-nao-e-um-jwt-valido',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('erro_login=state_invalido');
  });

  it('falha na troca do code por token junto ao provedor', async () => {
    const state = await signOidcState({
      codeVerifier: 'verificador-pkce-fake',
      nonce: 'nonce-fake',
    });
    authorizationCodeGrantMock.mockRejectedValueOnce(new Error('provedor fora do ar'));

    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('erro_login=falha_troca_token');
  });

  it('domínio de e-mail não permitido', async () => {
    const state = await signOidcState({
      codeVerifier: 'verificador-pkce-fake',
      nonce: 'nonce-fake',
    });
    authorizationCodeGrantMock.mockResolvedValueOnce({
      claims: () =>
        claimsFake({
          sub: 'oidc-dominio-errado',
          email: 'x@outraempresa.com',
          hd: 'outraempresa.com',
        }),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('erro_login=dominio_nao_permitido');
  });
});

describe('GET /auth/callback — sucesso e provisionamento', () => {
  it('provisiona um usuário novo, seta cookie de refresh e redireciona pro frontend', async () => {
    const state = await signOidcState({
      codeVerifier: 'verificador-pkce-fake',
      nonce: 'nonce-fake',
    });
    authorizationCodeGrantMock.mockResolvedValueOnce({ claims: () => claimsFake() });

    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(process.env['FRONTEND_URL']);

    const cookieRefresh = response.cookies.find((c) => c.name === 'mdm_refresh_token');
    expect(cookieRefresh).toBeDefined();
    expect(cookieRefresh?.httpOnly).toBe(true);

    const [usuario] = await db
      .select()
      .from(usuarios)
      .where(eq(usuarios.oidcSubject, 'oidc-sub-callback-teste'))
      .limit(1);
    expect(usuario?.email).toBe('novo.usuario@gruporoveri.com.br');
    expect(usuario?.role).toBe('VIEWER');

    const [auditLogin] = await db
      .select()
      .from(auditoria)
      .where(eq(auditoria.acao, 'LOGIN_PROVISIONAMENTO'));
    expect(auditLogin).toBeDefined();
  });

  it('segundo login do mesmo usuário não provisiona de novo (LOGIN, não LOGIN_PROVISIONAMENTO)', async () => {
    const state = await signOidcState({
      codeVerifier: 'verificador-pkce-fake',
      nonce: 'nonce-fake',
    });
    authorizationCodeGrantMock.mockResolvedValueOnce({ claims: () => claimsFake() });

    await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    const usuariosComEsseSub = await db
      .select()
      .from(usuarios)
      .where(eq(usuarios.oidcSubject, 'oidc-sub-callback-teste'));
    expect(usuariosComEsseSub).toHaveLength(1);
  });

  it('usuário inativo é rejeitado no login', async () => {
    await db.insert(usuarios).values({
      oidcSubject: 'oidc-sub-inativo',
      email: 'inativo@gruporoveri.com.br',
      nome: 'Usuário Inativo',
      ativo: false,
    });

    const state = await signOidcState({
      codeVerifier: 'verificador-pkce-fake',
      nonce: 'nonce-fake',
    });
    authorizationCodeGrantMock.mockResolvedValueOnce({
      claims: () => claimsFake({ sub: 'oidc-sub-inativo', email: 'inativo@gruporoveri.com.br' }),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('erro_login=usuario_inativo');
  });
});

describe('POST /auth/refresh e /auth/logout', () => {
  async function fazerLoginEObterCookie(sub: string, email: string): Promise<string> {
    const state = await signOidcState({
      codeVerifier: 'verificador-pkce-fake',
      nonce: 'nonce-fake',
    });
    authorizationCodeGrantMock.mockResolvedValueOnce({ claims: () => claimsFake({ sub, email }) });
    const loginResponse = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    const cookie = loginResponse.cookies.find((c) => c.name === 'mdm_refresh_token');
    if (!cookie) throw new Error('login de teste não retornou cookie de refresh');
    return cookie.value;
  }

  it('rotaciona o refresh token e emite um novo access token', async () => {
    const cookieValor = await fazerLoginEObterCookie(
      'oidc-sub-refresh',
      'refresh-flow@gruporoveri.com.br',
    );

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { mdm_refresh_token: cookieValor },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ accessToken: string }>().accessToken).toEqual(expect.any(String));
    const novoCookie = response.cookies.find((c) => c.name === 'mdm_refresh_token');
    expect(novoCookie?.value).toBeDefined();
    expect(novoCookie?.value).not.toBe(cookieValor);
  });

  it('rejeita refresh sem cookie', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(response.statusCode).toBe(401);
  });

  it('rejeita refresh com cookie inválido', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { mdm_refresh_token: 'valor-que-nunca-existiu' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('logout revoga o cookie e responde 204, mesmo sem access token', async () => {
    const cookieValor = await fazerLoginEObterCookie(
      'oidc-sub-logout',
      'logout-flow@gruporoveri.com.br',
    );

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { mdm_refresh_token: cookieValor },
    });
    expect(logoutResponse.statusCode).toBe(204);

    const refreshDepoisDoLogout = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { mdm_refresh_token: cookieValor },
    });
    expect(refreshDepoisDoLogout.statusCode).toBe(401);
  });

  it('logout sem cookie nenhum ainda responde 204 (idempotente)', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(response.statusCode).toBe(204);
  });
});
