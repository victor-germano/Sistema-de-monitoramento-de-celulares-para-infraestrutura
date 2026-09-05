import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.ts';
import type { Role } from '../../db/schema/usuarios.ts';

// HS256 com segredo simétrico (JWT_SECRET, mínimo 32 chars — validado em
// env.ts): suficiente aqui porque só esta aplicação emite e verifica esse
// token — não há terceiro precisando validar com uma chave pública
// separada. Se isso mudar (ex.: helpdesk externo verificando o JWT direto),
// migrar pra RS256/ES256 é uma troca isolada nesta função.
const SECRET = new TextEncoder().encode(env.JWT_SECRET);
const ALG = 'HS256';
const ISSUER = 'sistema-monitoramento-celulares';

export interface SessionClaims {
  /** `usuarios.id` (UUID v7). */
  sub: string;
  email: string;
  role: Role;
}

export async function signSessionToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${env.JWT_SESSION_TTL_MINUTES}m`)
    .sign(SECRET);
}

/** Lançada para qualquer token ausente, expirado, malformado ou com assinatura inválida. */
export class SessionTokenInvalidoError extends Error {
  constructor(cause: unknown) {
    super('token de sessão inválido ou expirado');
    this.cause = cause;
  }
}

export async function verifySessionToken(token: string): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(token, SECRET, { issuer: ISSUER, algorithms: [ALG] });

    // `jwtVerify` só garante que a ASSINATURA e os registered claims (exp,
    // iss) são válidos — não garante o formato dos claims customizados
    // (`email`, `role`). Validamos explicitamente antes de confiar no
    // shape: um token nosso de uma versão de schema antiga poderia ter um
    // formato diferente e passar despercebido sem esta checagem.
    const { sub, email, role } = payload;
    if (typeof sub !== 'string' || typeof email !== 'string' || typeof role !== 'string') {
      throw new Error('payload do token com formato inesperado');
    }

    return { sub, email, role: role as Role };
  } catch (error) {
    throw new SessionTokenInvalidoError(error);
  }
}
