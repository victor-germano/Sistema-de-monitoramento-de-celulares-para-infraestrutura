import { describe, expect, it } from 'vitest';
import { obterClienteAmapi, nomeEnterprise } from '../../src/integrations/amapi/client.ts';

// `GoogleAuth` só lê/valida o arquivo de credencial quando alguém pede um
// token de verdade (`getClient()`/primeira chamada HTTP) — a CONSTRUÇÃO do
// client é só wiring de objeto, sem I/O nem rede. Por isso dá pra testar a
// montagem do client sem precisar de uma service account real, mesmo
// `AMAPI_SERVICE_ACCOUNT_KEY_PATH` apontando pra um arquivo que não existe
// neste ambiente de teste (ver test/setup.ts).
describe('client.ts', () => {
  it('monta o client da AMAPI com os recursos esperados (enterprises.policies/devices/enrollmentTokens)', async () => {
    const cliente = await obterClienteAmapi();
    expect(cliente.enterprises.policies).toBeDefined();
    expect(cliente.enterprises.devices).toBeDefined();
    expect(cliente.enterprises.enrollmentTokens).toBeDefined();
  });

  it('é singleton — chamadas repetidas devolvem a mesma instância, sem reconstruir', async () => {
    const primeiro = await obterClienteAmapi();
    const segundo = await obterClienteAmapi();
    expect(primeiro).toBe(segundo);
  });

  it('nomeEnterprise devolve o valor configurado em AMAPI_ENTERPRISE_NAME', () => {
    expect(nomeEnterprise()).toMatch(/^enterprises\//);
  });
});
