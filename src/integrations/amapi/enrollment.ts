import { obterClienteAmapi, nomeEnterprise } from './client.ts';
import { comRetryEBackoff } from './retry.ts';
import { formatarDuracaoEmSegundos } from './mappers.ts';

// Sem duração explícita no pedido de criação, 1h é um valor conservador pra
// um token de enrollment (uso único, seção 7) — vida curta o bastante pra
// não virar um QR code esquecido rodando por aí, longa o bastante pra dar
// tempo de escanear e provisionar o device numa filial.
const DURACAO_PADRAO_SEGUNDOS = 60 * 60;

export interface AdditionalDataEnrollment {
  /** UUID de `enrollment_tokens.id` — é o que o handler `ENROLLMENT` (Fase 4) usa pra achar a linha certa no nosso banco. */
  tokenId: string;
  patrimonio?: string;
  colaboradorId?: string;
}

export interface CriarEnrollmentTokenEntrada {
  /** Nome completo: `enterprises/{id}/policies/{policyId}`. */
  nomePolitica: string;
  additionalData: AdditionalDataEnrollment;
  duracaoSegundos?: number;
}

export interface EnrollmentTokenCriado {
  /** `enterprises/{id}/enrollmentTokens/{tokenId}` — vira `enrollment_tokens.amapi_token_name`. */
  nomeRecurso: string | undefined;
  /** Valor bruto do token — NUNCA persistir puro (mesma regra do refresh token); quem chama faz o hash antes de salvar. */
  valor: string | undefined;
  /** É o `qrPayload` que a seção 10 pede em `POST /enrollment/tokens`. */
  qrCode: string | undefined;
  expiraEm: Date | undefined;
}

/**
 * `additionalData` é opaca pro Google — usamos SEMPRE (seção 7) pra
 * carregar o `tokenId` interno (e patrimônio/colaborador quando já
 * conhecidos no momento da criação), permitindo ligar o device recém-
 * provisionado ao colaborador certo assim que o evento `ENROLLMENT` chegar,
 * sem depender de nenhuma correlação por timing.
 *
 * `oneTimeOnly: true` e `allowPersonalUsage: 'PERSONAL_USAGE_DISALLOWED'`
 * em TODO token, sem exceção (seção 7) — frota 100% corporativa, sem BYOD.
 */
export async function criarEnrollmentToken(
  entrada: CriarEnrollmentTokenEntrada,
): Promise<EnrollmentTokenCriado> {
  const cliente = await obterClienteAmapi();

  const resposta = await comRetryEBackoff(() =>
    cliente.enterprises.enrollmentTokens.create({
      parent: nomeEnterprise(),
      requestBody: {
        policyName: entrada.nomePolitica,
        additionalData: JSON.stringify(entrada.additionalData),
        oneTimeOnly: true,
        allowPersonalUsage: 'PERSONAL_USAGE_DISALLOWED',
        duration: formatarDuracaoEmSegundos(entrada.duracaoSegundos ?? DURACAO_PADRAO_SEGUNDOS),
      },
    }),
  );

  const dados = resposta.data;
  return {
    nomeRecurso: dados.name ?? undefined,
    valor: dados.value ?? undefined,
    qrCode: dados.qrCode ?? undefined,
    expiraEm: dados.expirationTimestamp ? new Date(dados.expirationTimestamp) : undefined,
  };
}

/** Usado por `DELETE /enrollment/tokens/:id` (seção 10) pra revogar antes do uso. */
export async function revogarEnrollmentToken(nomeRecurso: string): Promise<void> {
  const cliente = await obterClienteAmapi();
  await comRetryEBackoff(() => cliente.enterprises.enrollmentTokens.delete({ name: nomeRecurso }));
}
