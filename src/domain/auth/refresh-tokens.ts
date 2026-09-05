import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { refreshTokens } from '../../db/schema/refresh-tokens.ts';
import { env } from '../../config/env.ts';

// Nunca o token opaco em texto puro no banco (ver comentário no schema) —
// sha256 é suficiente aqui porque o valor comparado já é um segredo de alta
// entropia gerado por nós (32 bytes aleatórios), não uma senha de usuário
// sujeita a dicionário/força-bruta offline — dispensa custo de bcrypt/scrypt.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function gerarTokenOpaco(): string {
  return randomBytes(32).toString('base64url');
}

export interface RefreshTokenContexto {
  ip?: string;
  userAgent?: string;
}

export interface RefreshTokenEmitido {
  token: string;
  expiraEm: Date;
}

export async function criarRefreshToken(
  usuarioId: string,
  contexto: RefreshTokenContexto = {},
): Promise<RefreshTokenEmitido> {
  const token = gerarTokenOpaco();
  const expiraEm = new Date(Date.now() + env.REFRESH_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  await db.insert(refreshTokens).values({
    usuarioId,
    tokenHash: hashToken(token),
    expiraEm,
    ip: contexto.ip,
    userAgent: contexto.userAgent,
  });

  return { token, expiraEm };
}

/** Token ausente, já usado (rotacionado), revogado ou expirado. */
export class RefreshTokenInvalidoError extends Error {
  constructor() {
    super('refresh token inválido, expirado ou já utilizado');
  }
}

export interface RefreshTokenRotacionado extends RefreshTokenEmitido {
  usuarioId: string;
}

/**
 * Rotação: todo uso de um refresh token válido invalida ELE (marca
 * `revogadoEm` + `substituidoPor`) e emite um novo. Um token que já foi
 * rotacionado (ou revogado por logout) não serve pra rotacionar de novo —
 * `WHERE revogadoEm IS NULL AND expiraEm > now()` garante isso. Reuso de um
 * token já rotacionado é sinal de token roubado sendo usado em paralelo ao
 * legítimo; nesta fase isso só resulta em 401 (RefreshTokenInvalidoError) —
 * revogar em cascata toda a "família" de tokens do usuário nesse cenário é
 * um endurecimento de segurança real, mas fora do escopo desta fase (não
 * pedido pela spec; registrado como pendência, não implementado em silêncio).
 */
export async function rotacionarRefreshToken(
  tokenAntigo: string,
  contexto: RefreshTokenContexto = {},
): Promise<RefreshTokenRotacionado> {
  const hashAntigo = hashToken(tokenAntigo);

  return db.transaction(async (tx) => {
    const [registro] = await tx
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, hashAntigo),
          isNull(refreshTokens.revogadoEm),
          gt(refreshTokens.expiraEm, new Date()),
        ),
      )
      .limit(1);

    if (!registro) {
      throw new RefreshTokenInvalidoError();
    }

    const novoToken = gerarTokenOpaco();
    const expiraEm = new Date(Date.now() + env.REFRESH_TOKEN_TTL_HOURS * 60 * 60 * 1000);

    const [novoRegistro] = await tx
      .insert(refreshTokens)
      .values({
        usuarioId: registro.usuarioId,
        tokenHash: hashToken(novoToken),
        expiraEm,
        ip: contexto.ip,
        userAgent: contexto.userAgent,
      })
      .returning({ id: refreshTokens.id });

    if (!novoRegistro) {
      throw new Error('falha ao inserir o novo refresh token na rotação');
    }

    await tx
      .update(refreshTokens)
      .set({ revogadoEm: new Date(), substituidoPor: novoRegistro.id })
      .where(eq(refreshTokens.id, registro.id));

    return { token: novoToken, expiraEm, usuarioId: registro.usuarioId };
  });
}

/** Usado no logout — idempotente: revogar um token já revogado não é erro. */
export async function revogarRefreshToken(token: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revogadoEm: new Date() })
    .where(and(eq(refreshTokens.tokenHash, hashToken(token)), isNull(refreshTokens.revogadoEm)));
}
