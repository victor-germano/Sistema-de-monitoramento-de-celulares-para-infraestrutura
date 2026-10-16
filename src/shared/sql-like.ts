// `\` é o caractere de escape padrão do Postgres em LIKE/ILIKE (sem precisar
// de `ESCAPE` explícito) — sem escapar o termo de busca do usuário, `%` e
// `_` são interpretados como wildcard em vez de caractere literal. Alguém
// buscando por "100%" ou "usuario_teste" recebia resultado errado (ou vazio)
// sem avisar que o termo foi interpretado como padrão, não texto exato.
// Backslash primeiro, sempre — senão o escape dos outros dois caracteres
// seria escapado de novo.
export function escaparTermoBusca(termo: string): string {
  return termo.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
