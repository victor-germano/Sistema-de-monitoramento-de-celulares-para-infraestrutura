import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Testes de integração sobem containers reais (Postgres/Redis) via
    // Testcontainers — precisam de mais tempo que o padrão de 5s do Vitest,
    // tanto pra baixar a imagem na primeira vez quanto pro container ficar
    // pronto (healthcheck).
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Metas da seção 14 da spec: 80% geral, 100% em pontos críticos.
      // O enforcement por arquivo (policy-invariants, rbac, mappers) entra
      // quando esses módulos existirem, a partir da Fase 2/3.
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
    },
  },
});
