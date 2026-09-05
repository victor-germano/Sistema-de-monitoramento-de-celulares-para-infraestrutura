import type { androidmanagement_v1 } from 'googleapis';

// ADR-015 (docs/DECISOES.md): o schema ATUAL da AMAPI (conferido no cliente
// oficial `googleapis` v178 e na documentação REST do Google) não tem um
// campo `uninstallBlocked` em `ApplicationPolicy` — o mecanismo real e
// suficiente é `Policy.uninstallAppsDisabled`, que a própria doc do Google
// descreve como "prevents apps from being uninstalled, even those removed
// using `applications`". Por pedido explícito do Victor, o campo por-app
// TAMBÉM é escrito, de forma defensiva: se a AMAPI de produção da empresa
// algum dia expuser esse campo (versão diferente, campo em beta não
// documentado), o valor certo já está lá; se não, é um campo desconhecido
// que a API ignora — nunca a única linha de defesa.
type PolicyPayload = androidmanagement_v1.Schema$Policy;
// Exportado (não só uso interno) pra quem monta payload de teste/entrada
// poder tipar `applications[]` incluindo o campo defensivo sem precisar de
// `as`/cast em cada literal — ver ADR-015 sobre por que o campo existe.
export type AppPolicy = androidmanagement_v1.Schema$ApplicationPolicy & {
  uninstallBlocked?: boolean;
};

const INSTALL_TYPES_SEMPRE_PERMITIDOS = ['FORCE_INSTALLED', 'AVAILABLE', 'PREINSTALLED'] as const;

export interface InvariantOverride {
  campo: string;
  valorRecebido: unknown;
  valorForcado: unknown;
}

export interface ResultadoInvariantes {
  policy: PolicyPayload;
  /** Vazio quando o payload recebido já respeitava tudo — nada foi sobrescrito. */
  overrides: InvariantOverride[];
}

function registrarSeDiferente(
  overrides: InvariantOverride[],
  campo: string,
  valorRecebido: unknown,
  valorForcado: unknown,
): void {
  if (valorRecebido !== valorForcado) {
    overrides.push({ campo, valorRecebido, valorForcado });
  }
}

/**
 * Aplica os invariantes da seção 3 sobre um payload de política e devolve,
 * junto do payload corrigido, a lista do que precisou ser sobrescrito — é
 * essa lista que o caminho de escrita (Fase 5, `POST/PATCH /policies`) usa
 * pra gravar a auditoria `INVARIANT_OVERRIDE` quando `overrides.length > 0`.
 * `enforceInvariants` (abaixo) é o wrapper síncrono só-com-o-payload que a
 * spec pede como assinatura pública; esta função é a implementação real.
 */
export function aplicarInvariantesComAuditoria(policy: PolicyPayload): ResultadoInvariantes {
  const overrides: InvariantOverride[] = [];

  // --- Nível de política -----------------------------------------------
  registrarSeDiferente(overrides, 'uninstallAppsDisabled', policy.uninstallAppsDisabled, true);
  registrarSeDiferente(overrides, 'installAppsDisabled', policy.installAppsDisabled, false);
  registrarSeDiferente(overrides, 'playStoreMode', policy.playStoreMode, 'WHITELIST');
  registrarSeDiferente(
    overrides,
    'installUnknownSourcesAllowed',
    policy.installUnknownSourcesAllowed,
    false,
  );

  // --- Nível de app -------------------------------------------------------
  // `BLOCKED` só é aceito se já era `BLOCKED` no payload recebido — o
  // invariante não decide sozinho o que bloquear (isso é uma decisão de
  // negócio de quem monta a política), só impede que um app que NÃO foi
  // explicitamente bloqueado escape do invariante de não-remoção por vir
  // com um installType fora da lista permitida (typo, payload antigo,
  // valor inesperado da AMAPI).
  const applications = (policy.applications ?? []).map((app, indice): AppPolicy => {
    const appTipado = app as AppPolicy;
    const installTypeOriginal = appTipado.installType;
    const eraExplicitamenteBloqueado = installTypeOriginal === 'BLOCKED';

    const installTypeForcado =
      eraExplicitamenteBloqueado ||
      INSTALL_TYPES_SEMPRE_PERMITIDOS.includes(
        installTypeOriginal as (typeof INSTALL_TYPES_SEMPRE_PERMITIDOS)[number],
      )
        ? installTypeOriginal
        : 'FORCE_INSTALLED';

    registrarSeDiferente(
      overrides,
      `applications[${indice}].installType`,
      installTypeOriginal,
      installTypeForcado,
    );
    registrarSeDiferente(
      overrides,
      `applications[${indice}].uninstallBlocked`,
      appTipado.uninstallBlocked,
      true,
    );

    return { ...appTipado, installType: installTypeForcado, uninstallBlocked: true };
  });

  const policyCorrigida: PolicyPayload = {
    ...policy,
    uninstallAppsDisabled: true,
    installAppsDisabled: false,
    playStoreMode: 'WHITELIST',
    installUnknownSourcesAllowed: false,
    applications,
  };

  return { policy: policyCorrigida, overrides };
}

/**
 * Assinatura exigida pela seção 3: aplicada obrigatoriamente no caminho de
 * escrita, imediatamente antes de qualquer `enterprises.policies.patch`.
 * Sem flag, sem bypass, nem para role ADMIN — não existe parâmetro nenhum
 * pra desligar isso, de propósito.
 */
export function enforceInvariants(policy: PolicyPayload): PolicyPayload {
  return aplicarInvariantesComAuditoria(policy).policy;
}
