// Config plana (ESLint 9). TypeScript com regras type-aware via o pacote
// unificado `typescript-eslint`; Prettier cuida de formatação (por isso
// `eslint-config-prettier` desliga regras de estilo que conflitariam com
// o Prettier em vez de duplicar responsabilidade).
//
// As regras type-aware (`parserOptions.project`) só se aplicam aos arquivos
// que o `tsconfig.json` realmente inclui (src/, test/ e os configs raiz que
// foram adicionados lá) — este próprio arquivo (`eslint.config.js`) fica de
// fora: é JS puro, não faz parte do `tsconfig.json`, e não precisa de
// verificação de tipos.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'drizzle/migrations/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts', 'drizzle.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Cargas vindas do SDK do Google (AMAPI) e do Pub/Sub chegam como
      // `unknown`/`any` — proibir `any` tornaria o adapter impraticável.
      // Preferimos revisão manual no code review a um lint quebrando o build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  prettierConfig,
);
