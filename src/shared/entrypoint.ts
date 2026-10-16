import { pathToFileURL } from 'node:url';

/**
 * Confere se o módulo que chamou foi executado diretamente (`node arquivo.ts`
 * / `tsx arquivo.ts`), não importado por outro módulo/teste — usado pelos
 * workers dedicados (`src/workers/*.ts`) pra só iniciar quando rodados como
 * processo próprio.
 *
 * Recebe `moduleUrl`/`argv1` como parâmetros (em vez de ler `import.meta.url`
 * aqui dentro) porque `import.meta.url` sempre se refere ao módulo em que
 * aparece no código-fonte — não dá pra centralizar essa leitura sem quebrar
 * o valor.
 *
 * Achado numa revisão: a comparação literal `import.meta.url === 'file://' +
 * process.argv[1]` nunca bate no Windows — `process.argv[1]` vem com `\` e
 * sem o prefixo `file://` (ex. `C:\...\arquivo.ts`), enquanto `import.meta.url`
 * é sempre uma URL `file:///C:/.../arquivo.ts` (barras normais, 3 barras).
 * `pathToFileURL` normaliza os dois lados da mesma forma, em qualquer SO.
 */
export function ehExecutadoDiretamente(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}
