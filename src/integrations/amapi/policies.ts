import type { androidmanagement_v1 } from 'googleapis';
import { obterClienteAmapi, nomeEnterprise } from './client.ts';
import { comRetryEBackoff } from './retry.ts';
import { enforceInvariants } from '../../domain/policy/policy-invariants.ts';

export type PolicyPayload = androidmanagement_v1.Schema$Policy;

// Nenhum controller/route importa `googleapis` direto (seção 7) — tudo
// passa por aqui, o que mantém o domínio testável com mocks e é o único
// lugar que precisa saber a forma exata dos parâmetros da AMAPI.

export async function obterPolitica(nomePolitica: string): Promise<PolicyPayload> {
  const cliente = await obterClienteAmapi();
  const resposta = await comRetryEBackoff(() =>
    cliente.enterprises.policies.get({ name: nomePolitica }),
  );
  return resposta.data;
}

export async function listarPoliticas(): Promise<PolicyPayload[]> {
  const cliente = await obterClienteAmapi();
  const resposta = await comRetryEBackoff(() =>
    cliente.enterprises.policies.list({ parent: nomeEnterprise() }),
  );
  return resposta.data.policies ?? [];
}

/** Só é permitido pela própria AMAPI se nenhum device ainda referenciar a política. */
export async function excluirPolitica(nomePolitica: string): Promise<void> {
  const cliente = await obterClienteAmapi();
  await comRetryEBackoff(() => cliente.enterprises.policies.delete({ name: nomePolitica }));
}

/**
 * `policies.patch` é upsert e propaga automaticamente pra toda a frota
 * associada àquela política — nunca iterar dispositivos aplicando um por
 * um (seção 7, e é por isso que a escrita passa pela fila serializada em
 * `src/queues/policy-write-queue.ts`, não por chamada direta da rota).
 *
 * `enforceInvariants` roda SEMPRE, imediatamente antes da chamada — é
 * aqui, no adapter, que a garantia da seção 3 vale de verdade, não em quem
 * chama esta função. Sem flag de bypass.
 */
export async function salvarPolitica(
  nomePolitica: string,
  payload: PolicyPayload,
): Promise<PolicyPayload> {
  const payloadSeguro = enforceInvariants(payload);
  const cliente = await obterClienteAmapi();
  const resposta = await comRetryEBackoff(() =>
    cliente.enterprises.policies.patch({ name: nomePolitica, requestBody: payloadSeguro }),
  );
  return resposta.data;
}
