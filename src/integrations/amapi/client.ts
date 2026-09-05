import { google, type androidmanagement_v1 } from 'googleapis';
import { env } from '../../config/env.ts';

// Singleton: a autenticação da service account (leitura do JSON + troca por
// access token) tem custo — cacheamos o client autenticado no módulo em vez
// de recriar a cada chamada. `GoogleAuth` já cuida de renovar o access token
// sozinho quando expira; não precisamos invalidar esse cache por tempo.
let clientePromise: Promise<androidmanagement_v1.Androidmanagement> | undefined;

export function obterClienteAmapi(): Promise<androidmanagement_v1.Androidmanagement> {
  clientePromise ??= criarCliente();
  return clientePromise;
}

// Função à parte (em vez de IIFE inline) porque a construção em si é
// síncrona — só o retorno é empacotado em Promise, pra manter a API pública
// preparada caso a autenticação um dia precise de um passo assíncrono de
// verdade (ex.: troca de credencial via um serviço externo).
function criarCliente(): Promise<androidmanagement_v1.Androidmanagement> {
  const auth = new google.auth.GoogleAuth({
    keyFile: env.AMAPI_SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/androidmanagement'],
  });
  return Promise.resolve(google.androidmanagement({ version: 'v1', auth }));
}

/** Nome do recurso da enterprise já vinculada — nunca criado em runtime (seção 2). */
export function nomeEnterprise(): string {
  return env.AMAPI_ENTERPRISE_NAME;
}
