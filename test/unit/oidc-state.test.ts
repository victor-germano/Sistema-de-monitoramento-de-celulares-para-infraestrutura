import { describe, expect, it } from 'vitest';
import {
  signOidcState,
  verifyOidcState,
  OidcStateInvalidoError,
} from '../../src/domain/auth/oidc-state.ts';

describe('oidc-state', () => {
  it('round-trip: assina e recupera codeVerifier/nonce intactos', async () => {
    const payload = { codeVerifier: 'verificador-pkce-de-teste', nonce: 'nonce-de-teste' };
    const state = await signOidcState(payload);
    await expect(verifyOidcState(state)).resolves.toEqual(payload);
  });

  it('rejeita state adulterado', async () => {
    const state = await signOidcState({ codeVerifier: 'a', nonce: 'b' });
    const [header, payload, signature] = state.split('.');
    // Adultera um caractere no MEIO do payload, não no fim da assinatura: o
    // último caractere base64url de uma assinatura HS256 codifica só 4 bits
    // significativos (256 bits não é múltiplo de 6) — trocar exatamente
    // esse caractere às vezes decodifica pro MESMO byte, e o teste passaria
    // por sorte em vez de por garantia. Um caractere no meio do payload é
    // sempre um grupo base64 completo (6 bits reais): trocar o alfabeto ali
    // sempre muda os bytes decodificados, então a assinatura sempre deixa
    // de bater.
    const meio = Math.floor(payload!.length / 2);
    const payloadAdulterado =
      payload!.slice(0, meio) + (payload!.at(meio) === 'a' ? 'b' : 'a') + payload!.slice(meio + 1);
    const adulterado = `${header}.${payloadAdulterado}.${signature}`;

    await expect(verifyOidcState(adulterado)).rejects.toBeInstanceOf(OidcStateInvalidoError);
  });

  it('rejeita string vazia ou arbitrária', async () => {
    await expect(verifyOidcState('')).rejects.toBeInstanceOf(OidcStateInvalidoError);
    await expect(verifyOidcState('nao-e-um-jwt-valido')).rejects.toBeInstanceOf(
      OidcStateInvalidoError,
    );
  });
});
