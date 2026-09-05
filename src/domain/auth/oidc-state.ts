import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.ts';

// ADR-010 (docs/DECISOES.md): a API não guarda sessão nenhuma antes do
// login (não existe usuário autenticado ainda) e não usa cookie de sessão
// de servidor (sem Redis/store pra isso, e adicionar um só pra 5 minutos de
// vida do fluxo de login seria peso desnecessário). Em vez de um cookie de
// state, o `code_verifier` (PKCE) e o `nonce` viajam DENTRO do próprio
// parâmetro `state` do OAuth, como um JWT curto assinado por nós — o
// provedor devolve esse `state` verbatim no callback (é assim que OAuth
// state sempre funciona), então basta verificar a assinatura pra recuperar
// os dois valores com confiança de que não foram adulterados no caminho.
const SECRET = new TextEncoder().encode(env.JWT_SECRET);
const ALG = 'HS256';
const ISSUER = 'sistema-monitoramento-celulares:oidc-state';
// Generoso o bastante pro usuário completar o login no IdP (digitar senha,
// 2FA, etc.) sem expirar no meio do caminho, mas curto — é só o tempo de
// uma ida-e-volta de OAuth, não uma sessão.
const TTL = '10m';

export interface OidcStatePayload {
  codeVerifier: string;
  nonce: string;
}

export async function signOidcState(payload: OidcStatePayload): Promise<string> {
  return new SignJWT({ codeVerifier: payload.codeVerifier, nonce: payload.nonce })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(SECRET);
}

export class OidcStateInvalidoError extends Error {
  constructor(cause?: unknown) {
    super('parâmetro state do OIDC inválido, expirado ou ausente');
    this.cause = cause;
  }
}

export async function verifyOidcState(state: string): Promise<OidcStatePayload> {
  try {
    const { payload } = await jwtVerify(state, SECRET, { issuer: ISSUER, algorithms: [ALG] });
    const { codeVerifier, nonce } = payload;
    if (typeof codeVerifier !== 'string' || typeof nonce !== 'string') {
      throw new Error('payload do state OIDC com formato inesperado');
    }
    return { codeVerifier, nonce };
  } catch (error) {
    throw new OidcStateInvalidoError(error);
  }
}
