import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { refreshTokens } from '../../db/schema/refresh-tokens.ts';
import { env } from '../../config/env.ts';

// Nunca o token opaco em texto puro no banco (ver comentário no schema) —
// sha256 é suficiente aqui porque o valor comparado já é um segredo de alta
// entropia gerado por nós (32 bytes aleatórios), não uma senha de usuário
// sujeita a dicionário/força-bruta offline — dispensa custo de bcrypt/scrypt.
// Exportada (não só uso interno) como seam de teste: simular um token
// expirado exige localizar a linha certa em `refresh_tokens` a partir do
// valor bruto, e a tabela só guarda o hash — ver
// `test/integration/refresh-tokens.test.ts`.
export function hashToken(token: string): string {
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
 * `revogadoEm` + `substituidoPor`) e emite um novo.
 *
 * Reuso de um token JÁ ROTACIONADO (não simplesmente expirado) é tratado
 * como sinal de token roubado sendo usado em paralelo ao legítimo — a
 * resposta cirúrgica e prática pra isso é revogar TODOS os refresh tokens
 * ativos daquele usuário (não só o reutilizado), forçando login de novo em
 * qualquer sessão, inclusive a legítima que rotacionou por último. É menos
 * sofisticado que rastrear uma "família" de tokens por device/sessão, mas
 * fecha o cenário real de abuso sem precisar de coluna nova nenhuma no
 * schema. Diferente disso: um token simplesmente EXPIRADO (nunca revogado)
 * não é sinal de roubo — só dá 401 normal, sem cascata.
 */
export async function rotacionarRefreshToken(
  tokenAntigo: string,
  contexto: RefreshTokenContexto = {},
): Promise<RefreshTokenRotacionado> {
  const hashAntigo = hashToken(tokenAntigo);

  // Resultado tipado em vez de `throw` de dentro da transação: `throw`
  // dentro de `db.transaction()` faz ROLLBACK de tudo, inclusive do UPDATE
  // de cascata do caso "reuso detectado" — a cascata precisa COMMITAR antes
  // de reportarmos o erro pro caller. Achado testando de verdade: sem isso,
  // a rota de teste "revoga as outras sessões" falhava porque a cascata
  // nunca persistia.
  const resultado = await db.transaction(async (tx) => {
    // Sem o filtro de `revogadoEm`/`expiraEm` aqui de propósito — precisamos
    // saber POR QUE o token não serve (nunca existiu? já foi revogado? só
    // expirou?) pra decidir se é caso de cascata ou só 401 normal.
    const [registro] = await tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashAntigo))
      .limit(1);

    if (!registro) {
      return { valido: false as const };
    }

    if (registro.revogadoEm !== null) {
      // Reuso de token já revogado/rotacionado: derruba a sessão inteira.
      await tx
        .update(refreshTokens)
        .set({ revogadoEm: new Date() })
        .where(
          and(eq(refreshTokens.usuarioId, registro.usuarioId), isNull(refreshTokens.revogadoEm)),
        );
      return { valido: false as const };
    }

    if (registro.expiraEm <= new Date()) {
      // Só expirou normalmente — não é sinal de roubo, sem cascata.
      return { valido: false as const };
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
      // Este sim é um erro interno de verdade (falha inesperada do INSERT)
      // — faz sentido dar ROLLBACK em tudo, por isso `throw` aqui.
      throw new Error('falha ao inserir o novo refresh token na rotação');
    }

    await tx
      .update(refreshTokens)
      .set({ revogadoEm: new Date(), substituidoPor: novoRegistro.id })
      .where(eq(refreshTokens.id, registro.id));

    return {
      valido: true as const,
      token: novoToken,
      expiraEm,
      usuarioId: registro.usuarioId,
    };
  });

  if (!resultado.valido) {
    throw new RefreshTokenInvalidoError();
  }

  return resultado;
}

/** Usado no logout — idempotente: revogar um token já revogado não é erro. */
export async function revogarRefreshToken(token: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revogadoEm: new Date() })
    .where(and(eq(refreshTokens.tokenHash, hashToken(token)), isNull(refreshTokens.revogadoEm)));
}
