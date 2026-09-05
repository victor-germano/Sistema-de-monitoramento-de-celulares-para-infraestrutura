import { describe, expect, it } from 'vitest';
import {
  entraIdValidator,
  googleWorkspaceValidator,
  resolverOidcDomainValidator,
  validarDominioCorporativo,
} from '../../src/integrations/oidc/domain-validator.ts';

describe('googleWorkspaceValidator (claim hd)', () => {
  it('extrai o domínio da claim hd', () => {
    expect(googleWorkspaceValidator.extrairDominio({ hd: 'gruporoveri.com.br' })).toBe(
      'gruporoveri.com.br',
    );
  });

  it('retorna undefined quando não há hd (conta pessoal Google, não Workspace)', () => {
    expect(googleWorkspaceValidator.extrairDominio({ email: 'alguem@gmail.com' })).toBeUndefined();
  });
});

describe('entraIdValidator (claim email/upn — tid não é domínio, ver ADR-003)', () => {
  it('extrai o domínio a partir do e-mail', () => {
    expect(
      entraIdValidator.extrairDominio({
        email: 'pessoa@gruporoveri.com.br',
        tid: 'guid-do-tenant',
      }),
    ).toBe('gruporoveri.com.br');
  });

  it('cai para upn quando não há email', () => {
    expect(entraIdValidator.extrairDominio({ upn: 'pessoa@gruporoveri.com.br' })).toBe(
      'gruporoveri.com.br',
    );
  });

  it('retorna undefined sem email nem upn', () => {
    expect(entraIdValidator.extrairDominio({ tid: 'guid-do-tenant' })).toBeUndefined();
  });
});

describe('resolverOidcDomainValidator', () => {
  it('escolhe o validator do Google para accounts.google.com', () => {
    expect(resolverOidcDomainValidator('https://accounts.google.com')).toBe(
      googleWorkspaceValidator,
    );
  });

  it('escolhe o validator do Entra para login.microsoftonline.com', () => {
    expect(resolverOidcDomainValidator('https://login.microsoftonline.com/tenant-id/v2.0')).toBe(
      entraIdValidator,
    );
  });
});

describe('validarDominioCorporativo', () => {
  const dominiosPermitidos = ['gruporoveri.com.br'];

  it('aceita claim hd do Google batendo com a lista permitida', () => {
    expect(
      validarDominioCorporativo(
        { hd: 'gruporoveri.com.br' },
        'https://accounts.google.com',
        dominiosPermitidos,
      ),
    ).toBe(true);
  });

  it('rejeita domínio Google fora da lista', () => {
    expect(
      validarDominioCorporativo(
        { hd: 'outraempresa.com.br' },
        'https://accounts.google.com',
        dominiosPermitidos,
      ),
    ).toBe(false);
  });

  it('rejeita quando não há como determinar o domínio', () => {
    expect(validarDominioCorporativo({}, 'https://accounts.google.com', dominiosPermitidos)).toBe(
      false,
    );
  });
});
