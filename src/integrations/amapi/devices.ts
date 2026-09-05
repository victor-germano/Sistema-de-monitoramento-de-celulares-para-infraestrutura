import type { androidmanagement_v1 } from 'googleapis';
import { obterClienteAmapi, nomeEnterprise } from './client.ts';
import { comRetryEBackoff } from './retry.ts';

export type DevicePayload = androidmanagement_v1.Schema$Device;

export async function obterDispositivo(nomeDispositivo: string): Promise<DevicePayload> {
  const cliente = await obterClienteAmapi();
  const resposta = await comRetryEBackoff(() =>
    cliente.enterprises.devices.get({ name: nomeDispositivo }),
  );
  return resposta.data;
}

export interface ListarDispositivosOpcoes {
  pageSize?: number;
  pageToken?: string;
}

export async function listarDispositivos(
  opcoes: ListarDispositivosOpcoes = {},
): Promise<{ dispositivos: DevicePayload[]; proximaPagina?: string }> {
  const cliente = await obterClienteAmapi();
  const resposta = await comRetryEBackoff(() =>
    cliente.enterprises.devices.list({
      parent: nomeEnterprise(),
      pageSize: opcoes.pageSize,
      pageToken: opcoes.pageToken,
    }),
  );
  return {
    dispositivos: resposta.data.devices ?? [],
    proximaPagina: resposta.data.nextPageToken ?? undefined,
  };
}

/**
 * Troca de política do dispositivo. Nunca usada pra aplicar CONFIGURAÇÃO —
 * isso é `salvarPolitica` (seção 7); esta função só reatribui QUAL política
 * o device usa (`PATCH /devices/:id/politica`, Fase 5).
 */
export async function trocarPoliticaDoDispositivo(
  nomeDispositivo: string,
  nomePolitica: string,
): Promise<DevicePayload> {
  const cliente = await obterClienteAmapi();
  const resposta = await comRetryEBackoff(() =>
    cliente.enterprises.devices.patch({
      name: nomeDispositivo,
      updateMask: 'policyName',
      requestBody: { policyName: nomePolitica },
    }),
  );
  return resposta.data;
}

export interface DesprovisionarOpcoes {
  wipeDataFlags?: string[];
  wipeReasonMessage?: string;
}

/** Wipe é feito via `devices.delete` com `wipeDataFlags` — não existe um endpoint "wipe" separado na AMAPI. */
export async function desprovisionarDispositivo(
  nomeDispositivo: string,
  opcoes: DesprovisionarOpcoes = {},
): Promise<void> {
  const cliente = await obterClienteAmapi();
  await comRetryEBackoff(() =>
    cliente.enterprises.devices.delete({
      name: nomeDispositivo,
      wipeDataFlags: opcoes.wipeDataFlags,
      wipeReasonMessage: opcoes.wipeReasonMessage,
    }),
  );
}
