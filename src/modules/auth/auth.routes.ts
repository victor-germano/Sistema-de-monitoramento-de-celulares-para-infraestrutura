import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { client, obterConfiguracaoOidc } from '../../integrations/oidc/client.ts';
import { validarDominioCorporativo } from '../../integrations/oidc/domain-validator.ts';
import {
  signOidcState,
  verifyOidcState,
  OidcStateInvalidoError,
} from '../../domain/auth/oidc-state.ts';
import { signSessionToken } from '../../domain/auth/session-tokens.ts';
import {
  criarRefreshToken,
  revogarRefreshToken,
  rotacionarRefreshToken,
  RefreshTokenInvalidoError,
} from '../../domain/auth/refresh-tokens.ts';
import { PERMISSOES_POR_ROLE } from '../../domain/auth/permissions.ts';
import {
  atualizarUsuario,
  atualizarUltimoLogin,
  buscarUsuarioPorId,
  buscarUsuarioPorOidcSubject,
  contarAdminsAtivos,
  listarUsuarios,
  provisionarUsuario,
} from '../../domain/usuarios/repositorio.ts';
import { registrarAuditoria } from '../../domain/auditoria/registrar.ts';
import { db } from '../../db/client.ts';
import { logger } from '../../shared/logger.ts';
import { sendProblem } from '../../shared/problem-details.ts';
import { PUBLICA, withRole } from '../../plugins/rbac.ts';

const REFRESH_COOKIE_NAME = 'mdm_refresh_token';

function opcoesCookieRefresh(expiraEm: Date) {
  return {
    httpOnly: true,
    // `false` em dev: sem HTTPS local, um cookie `secure` nunca seria
    // enviado pelo browser e o fluxo de login pareceria simplesmente não
    // persistir sessão nenhuma, sem erro nenhum pra explicar o motivo.
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    // Path restrito: o refresh token só precisa trafegar pras 3 rotas de
    // auth que o consomem — não faz sentido o browser mandar esse cookie
    // em toda chamada de API.
    path: '/auth',
    expires: expiraEm,
  };
}

function redirecionarComErro(reply: FastifyReply, motivo: string): FastifyReply {
  const url = new URL(env.FRONTEND_URL);
  url.searchParams.set('erro_login', motivo);
  return reply.redirect(url.toString());
}

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

const patchUsuarioParamsSchema = z.object({ id: z.string().uuid() });

export function registerAuthRoutes(app: FastifyInstance): void {
  const zodApp = app.withTypeProvider<ZodTypeProvider>();

  // --- GET /auth/login ------------------------------------------------------
  // Sem body/query — inicia o fluxo Authorization Code + PKCE redirecionando
  // pro provedor. Ver ADR-010 pra como o codeVerifier/nonce sobrevivem até o
  // callback sem sessão nem cookie de state.
  zodApp.get('/auth/login', PUBLICA, async (_request, reply) => {
    const configuracao = await obterConfiguracaoOidc();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const nonce = client.randomNonce();
    const state = await signOidcState({ codeVerifier, nonce });

    const url = client.buildAuthorizationUrl(configuracao, {
      redirect_uri: env.OIDC_REDIRECT_URI,
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    return reply.redirect(url.toString());
  });

  // --- GET /auth/callback ----------------------------------------------------
  zodApp.get(
    '/auth/callback',
    { ...PUBLICA, schema: { querystring: callbackQuerySchema } },
    async (request, reply) => {
      const { code, state, error } = request.query;

      if (error !== undefined) {
        logger.warn({ error }, 'usuário negou consentimento ou provedor retornou erro no OIDC');
        return redirecionarComErro(reply, 'provedor_recusou');
      }
      if (code === undefined || state === undefined) {
        return redirecionarComErro(reply, 'parametros_ausentes');
      }

      let codeVerifier: string;
      let nonce: string;
      try {
        ({ codeVerifier, nonce } = await verifyOidcState(state));
      } catch (err) {
        if (err instanceof OidcStateInvalidoError) {
          logger.warn({ err }, 'state OIDC inválido no callback');
          return redirecionarComErro(reply, 'state_invalido');
        }
        throw err;
      }

      const configuracao = await obterConfiguracaoOidc();
      // Base = OIDC_REDIRECT_URI (não o Host da requisição): evita confiar
      // em `Host`/`X-Forwarded-Host`, que um proxy mal configurado (ou um
      // atacante, sem proxy validando isso) poderia adulterar. O path e a
      // query vêm da requisição real; a origem vem sempre do que está
      // configurado como redirect_uri no provedor.
      const currentUrl = new URL(request.url, env.OIDC_REDIRECT_URI);

      let claims;
      try {
        const tokenResponse = await client.authorizationCodeGrant(configuracao, currentUrl, {
          pkceCodeVerifier: codeVerifier,
          expectedNonce: nonce,
          expectedState: state,
        });
        claims = tokenResponse.claims();
      } catch (err) {
        logger.error({ err }, 'falha na troca do code por token junto ao provedor OIDC');
        return redirecionarComErro(reply, 'falha_troca_token');
      }

      if (!claims) {
        logger.error('provedor OIDC não retornou id_token');
        return redirecionarComErro(reply, 'sem_id_token');
      }

      const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
      if (!email) {
        return redirecionarComErro(reply, 'sem_email');
      }

      if (!validarDominioCorporativo(claims, env.OIDC_ISSUER, env.ALLOWED_EMAIL_DOMAINS)) {
        await registrarAuditoria(db, {
          ator: null,
          acao: 'LOGIN_DOMINIO_REJEITADO',
          entidade: 'usuario',
          detalhes: { email },
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        return redirecionarComErro(reply, 'dominio_nao_permitido');
      }

      const nome = typeof claims['name'] === 'string' ? claims['name'] : email;
      let usuario = await buscarUsuarioPorOidcSubject(claims.sub);

      if (usuario && !usuario.ativo) {
        await registrarAuditoria(db, {
          ator: { id: usuario.id, email: usuario.email },
          acao: 'LOGIN_USUARIO_INATIVO',
          entidade: 'usuario',
          entidadeId: usuario.id,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        return redirecionarComErro(reply, 'usuario_inativo');
      }

      const eraNovoUsuario = !usuario;
      usuario ??= await provisionarUsuario({ oidcSubject: claims.sub, email, nome });
      await atualizarUltimoLogin(usuario.id);

      // Só o refresh token sai daqui (via cookie) — o access token de
      // sessão é emitido no primeiro `POST /auth/refresh` que o frontend
      // faz ao carregar, não aqui. Ver ADR-010: nada de token na URL do
      // redirect.
      const refreshToken = await criarRefreshToken(usuario.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      await registrarAuditoria(db, {
        ator: { id: usuario.id, email: usuario.email },
        acao: eraNovoUsuario ? 'LOGIN_PROVISIONAMENTO' : 'LOGIN',
        entidade: 'usuario',
        entidadeId: usuario.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      reply.setCookie(
        REFRESH_COOKIE_NAME,
        refreshToken.token,
        opcoesCookieRefresh(refreshToken.expiraEm),
      );

      // O frontend recebe só o refresh token (via cookie httpOnly — nunca
      // acessível a JS). O access token de sessão (JWT curto) NÃO viaja
      // pela URL do redirect — history/referrer de browser não são lugar
      // seguro pra um token, por mais curto que seja. O frontend chama
      // `POST /auth/refresh` assim que a página carregar (o cookie já
      // estará presente) pra obter o primeiro access token. Ver ADR-010.
      return reply.redirect(env.FRONTEND_URL);
    },
  );

  // --- POST /auth/refresh -----------------------------------------------------
  zodApp.post('/auth/refresh', PUBLICA, async (request, reply) => {
    const tokenAtual = request.cookies[REFRESH_COOKIE_NAME];
    if (!tokenAtual) {
      return sendProblem(reply, 401, 'Não autenticado', 'Nenhum refresh token presente.');
    }

    let rotacionado;
    try {
      rotacionado = await rotacionarRefreshToken(tokenAtual, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
    } catch (err) {
      if (err instanceof RefreshTokenInvalidoError) {
        reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
        return sendProblem(reply, 401, 'Sessão expirada', 'Faça login novamente.');
      }
      throw err;
    }

    // Busca o usuário fresco no banco — não confia em nenhum claim antigo:
    // é o que garante que uma promoção/rebaixamento de role feita via
    // `PATCH /usuarios/:id` valha no próximo refresh, sem esperar o access
    // token antigo expirar naturalmente.
    const usuario = await buscarUsuarioPorId(rotacionado.usuarioId);
    if (!usuario || !usuario.ativo) {
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
      return sendProblem(reply, 401, 'Não autenticado', 'Usuário inexistente ou inativo.');
    }

    reply.setCookie(
      REFRESH_COOKIE_NAME,
      rotacionado.token,
      opcoesCookieRefresh(rotacionado.expiraEm),
    );

    const sessionToken = await signSessionToken({
      sub: usuario.id,
      email: usuario.email,
      role: usuario.role,
    });

    return reply.send({
      accessToken: sessionToken,
      expiresIn: env.JWT_SESSION_TTL_MINUTES * 60,
    });
  });

  // --- POST /auth/logout -------------------------------------------------------
  // Pública do ponto de vista de autenticação por Bearer token — o que
  // autoriza este endpoint é POSSUIR o refresh token (cookie), não um
  // access token válido. Precisa funcionar mesmo com o access token já
  // expirado (o caso mais comum de "clicar em sair" depois de um tempo
  // ocioso).
  zodApp.post('/auth/logout', PUBLICA, async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE_NAME];
    if (token) {
      await revogarRefreshToken(token);
    }
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });

    await registrarAuditoria(db, {
      ator: request.user ? { id: request.user.sub, email: request.user.email } : null,
      acao: 'LOGOUT',
      entidade: 'usuario',
      entidadeId: request.user?.sub,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.status(204).send();
  });

  // --- GET /auth/me -------------------------------------------------------------
  zodApp.get(
    '/auth/me',
    withRole('VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR'),
    async (request, reply) => {
      // `withRole` já garante `request.user` não-nulo (401 antes de chegar
      // aqui) — a asserção documenta essa garantia pro typechecker.
      const sessao = request.user!;
      const usuario = await buscarUsuarioPorId(sessao.sub);
      if (!usuario) {
        return sendProblem(reply, 401, 'Não autenticado', 'Usuário não encontrado.');
      }

      return reply.send({
        id: usuario.id,
        email: usuario.email,
        nome: usuario.nome,
        role: usuario.role,
        permissoes: PERMISSOES_POR_ROLE[usuario.role],
      });
    },
  );

  // --- Gestão de usuário/role (ADR: gap da seção 10, ver docs/DECISOES.md) -----
  zodApp.get('/usuarios', withRole('ADMIN'), async (_request, reply) => {
    return reply.send(await listarUsuarios());
  });

  zodApp.patch(
    '/usuarios/:id',
    {
      ...withRole('ADMIN'),
      schema: {
        params: patchUsuarioParamsSchema,
        body: z.object({
          role: z.enum(['VIEWER', 'TECNICO', 'ADMIN', 'AUDITOR']).optional(),
          ativo: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { role, ativo } = request.body;
      if (role === undefined && ativo === undefined) {
        return sendProblem(
          reply,
          422,
          'Nada para atualizar',
          'Informe pelo menos um de: role, ativo.',
        );
      }

      const alvo = await buscarUsuarioPorId(request.params.id);
      if (!alvo) {
        return sendProblem(reply, 404, 'Usuário não encontrado', undefined);
      }

      // Salvaguarda cirúrgica (pendência registrada em ADR-011): rebaixar OU
      // DESATIVAR o ÚLTIMO ADMIN ativo deixaria o sistema sem ninguém capaz
      // de gerenciar usuários/roles — inclusive sem como reverter a própria
      // ação. Só verifica quando a mudança de fato tira o ADMIN de alguém
      // que já é o único; promover, manter ADMIN, ou ativar nunca cai aqui.
      const vaiRebaixar = role !== undefined && role !== 'ADMIN';
      const vaiDesativar = ativo === false;
      if (
        alvo.role === 'ADMIN' &&
        (vaiRebaixar || vaiDesativar) &&
        (await contarAdminsAtivos()) <= 1
      ) {
        return sendProblem(
          reply,
          422,
          'Não é possível remover o último ADMIN',
          'Promova outro usuário a ADMIN e/ou mantenha este ativo antes.',
        );
      }

      const dadosAtualizacao: { role?: typeof role; ativo?: boolean } = {};
      if (role !== undefined) dadosAtualizacao.role = role;
      if (ativo !== undefined) dadosAtualizacao.ativo = ativo;

      const usuarioAtualizado = await atualizarUsuario(alvo.id, dadosAtualizacao);
      if (!usuarioAtualizado) {
        return sendProblem(reply, 404, 'Usuário não encontrado', undefined);
      }

      await registrarAuditoria(db, {
        ator: { id: request.user!.sub, email: request.user!.email },
        acao: role !== undefined ? 'USUARIO_ROLE_ALTERADA' : 'USUARIO_ATIVO_ALTERADO',
        entidade: 'usuario',
        entidadeId: usuarioAtualizado.id,
        detalhes: {
          ...(role !== undefined && { novaRole: role }),
          ...(ativo !== undefined && { novoAtivo: ativo }),
        },
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.send(usuarioAtualizado);
    },
  );
}
