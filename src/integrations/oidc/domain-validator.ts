// ADR-003 (docs/DECISOES.md): a seção 5 da spec pede validar a claim `hd`
// (Google) ou `tid` (Entra) contra `ALLOWED_EMAIL_DOMAINS`. Isso não dá pra
// fazer com o MESMO critério nos dois provedores — `hd` no Google já É o
// domínio verificado pelo IdP; `tid` no Entra é o GUID do tenant, não um
// domínio, e comparar um GUID contra uma lista de domínios nunca bateria.
// Por isso: uma implementação de extração de domínio por provedor, e o
// código de callback usa só a função `validarDominioCorporativo` — não
// importa qual provedor está ativo por baixo.
export interface OidcDomainValidator {
  /**
   * Extrai o domínio de e-mail corporativo do usuário a partir dos claims
   * do ID Token já verificado. Retorna `undefined` quando não é possível
   * determinar o domínio com confiança nesse provedor.
   */
  extrairDominio(claims: Record<string, unknown>): string | undefined;
}

/** Google Workspace: `hd` é o domínio do Workspace, já verificado pelo próprio Google. */
export const googleWorkspaceValidator: OidcDomainValidator = {
  extrairDominio(claims) {
    return typeof claims['hd'] === 'string' ? claims['hd'] : undefined;
  },
};

/**
 * Microsoft Entra ID: sem equivalente direto a `hd`. `tid` é o GUID do
 * tenant — útil pra confirmar "é o mesmo tenant de sempre", mas não pra
 * comparar contra uma lista de domínios legíveis. Extrai o domínio do claim
 * `email` (ou `upn`, campo tradicional do Azure AD/Entra pra UPN quando
 * `email` não vem no ID Token) e assume esse valor como o domínio real —
 * mais fraco que a garantia do `hd` do Google, porque depende do e-mail
 * declarado no diretório em vez de uma claim específica de organização,
 * mas é o melhor sinal disponível sem uma chamada extra ao Microsoft Graph.
 */
export const entraIdValidator: OidcDomainValidator = {
  extrairDominio(claims) {
    const identificador =
      typeof claims['email'] === 'string'
        ? claims['email']
        : typeof claims['upn'] === 'string'
          ? claims['upn']
          : undefined;
    return identificador?.split('@')[1]?.toLowerCase();
  },
};

export function resolverOidcDomainValidator(issuer: string): OidcDomainValidator {
  const { hostname } = new URL(issuer);
  if (hostname === 'accounts.google.com') {
    return googleWorkspaceValidator;
  }
  if (hostname.endsWith('.microsoftonline.com') || hostname.endsWith('.microsoftonline.us')) {
    return entraIdValidator;
  }
  // Provedor não mapeado explicitamente: cai no critério mais genérico
  // (domínio a partir do e-mail). Não é a mesma garantia do `hd` verificado
  // do Google — documentado aqui pra quem for adicionar um terceiro
  // provedor não assumir que ganhou o mesmo nível de confiança de graça.
  return entraIdValidator;
}

export function validarDominioCorporativo(
  claims: Record<string, unknown>,
  issuer: string,
  dominiosPermitidos: readonly string[],
): boolean {
  const dominio = resolverOidcDomainValidator(issuer).extrairDominio(claims);
  return dominio !== undefined && dominiosPermitidos.includes(dominio);
}
