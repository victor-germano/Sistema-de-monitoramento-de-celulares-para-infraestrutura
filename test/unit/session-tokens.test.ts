import { describe, expect, it } from 'vitest';
import {
  signSessionToken,
  verifySessionToken,
  SessionTokenInvalidoError,
} from '../../src/domain/auth/session-tokens.ts';

describe('session-tokens', () => {
  const claims = {
    sub: 'usuario-123',
    email: 'tecnico@gruporoveri.com.br',
    role: 'TECNICO',
  } as const;

  it('assina e verifica um token válido, preservando os claims', async () => {
    const token = await signSessionToken(claims);
    const verificado = await verifySessionToken(token);
    expect(verificado).toEqual(claims);
  });

  it('rejeita um token adulterado (assinatura não bate)', async () => {
    const token = await signSessionToken(claims);
    const adulterado = token.slice(0, -2) + (token.at(-2) === 'a' ? 'b' : 'a') + token.at(-1);
    await expect(verifySessionToken(adulterado)).rejects.toBeInstanceOf(SessionTokenInvalidoError);
  });

  it('rejeita string que não é um JWT', async () => {
    await expect(verifySessionToken('isto-nao-e-um-jwt')).rejects.toBeInstanceOf(
      SessionTokenInvalidoError,
    );
  });

  it('rejeita um JWT de outro emissor (issuer não bate)', async () => {
    // Monta um JWT válido (mesma chave, mesmo algoritmo) mas com `iss`
    // diferente do esperado — simula um token de outro sistema/ambiente
    // usando o mesmo segredo por engano.
    const { SignJWT } = await import('jose');
    const { env } = await import('../../src/config/env.ts');
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const tokenDeOutroEmissor = await new SignJWT({ email: claims.email, role: claims.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer('outro-sistema-qualquer')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);

    await expect(verifySessionToken(tokenDeOutroEmissor)).rejects.toBeInstanceOf(
      SessionTokenInvalidoError,
    );
  });

  it('rejeita token já expirado', async () => {
    const { SignJWT } = await import('jose');
    const { env } = await import('../../src/config/env.ts');
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const tokenExpirado = await new SignJWT({ email: claims.email, role: claims.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer('sistema-monitoramento-celulares')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(secret);

    await expect(verifySessionToken(tokenExpirado)).rejects.toBeInstanceOf(
      SessionTokenInvalidoError,
    );
  });
});
