// Funções puras de tradução de formato entre o modelo interno e o shape da
// AMAPI (seção 7). Escopo desta fase: só os formatadores de duração que
// `policies.ts`/`enrollment.ts` já usam agora (seed de políticas, criação
// de enrollment token). Os mappers de Device/App (AMAPI -> `dispositivos`/
// `dispositivo_apps`) chegam na Fase 4, junto do handler `STATUS_REPORT`
// que é quem de fato os consome — escrever agora, sem um consumidor real
// pra validar o shape contra dados de verdade, é o tipo de código
// especulativo que rule 4 pede pra evitar.
//
// ADR-002: os dois formatos de "duração" da AMAPI NÃO são intercambiáveis.
// Cada campo abaixo documenta explicitamente qual é o seu, porque presumir
// "todo campo de duração usa sufixo `s`" é exatamente o erro que já
// aconteceria com `maximumTimeToLock`.

/**
 * `Policy.maximumTimeToLock`: int64 em MILISSEGUNDOS, serializado como
 * string SEM sufixo. Ex.: 10 minutos -> `"600000"`, não `"600000ms"` nem
 * `"600s"`.
 */
export function formatarMaximumTimeToLockMs(milissegundos: number): string {
  return String(Math.trunc(milissegundos));
}

/**
 * Campos do tipo `google.protobuf.Duration` da AMAPI — ex.:
 * `PasswordRequirements.passwordExpirationTimeout`, `Command.duration`,
 * `EnrollmentToken.duration`. Formato: inteiro em SEGUNDOS + sufixo `s`.
 * Ex.: 14 dias -> `"1209600s"`.
 */
export function formatarDuracaoEmSegundos(segundos: number): string {
  return `${Math.trunc(segundos)}s`;
}
