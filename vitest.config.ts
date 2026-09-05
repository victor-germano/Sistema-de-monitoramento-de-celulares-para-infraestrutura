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
      // `server.ts` é bootstrap de processo puro (bind de porta real,
      // handlers de SIGTERM/SIGINT, `process.exit`) — não tem lógica de
      // domínio pra testar, e testá-lo exigiria subir um processo Node
      // filho só pra isso. Excluído da cobertura por ser infraestrutura de
      // entrada, não código de negócio (mesmo raciocínio de por que
      // frameworks não cobram cobertura de `main()`).
      exclude: ['src/server.ts'],
      // Metas da seção 14 da spec: 80% geral, 100% em pontos críticos —
      // RBAC (`src/plugins/rbac.ts`) e o invariante de apps não-removíveis
      // (`src/domain/policy/policy-invariants.ts`, critério explícito da
      // Fase 3). Os mappers da AMAPI entram no mesmo padrão quando
      // existirem endpoints reais consumindo-os (Fase 4+).
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
        'src/plugins/rbac.ts': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
        'src/domain/policy/policy-invariants.ts': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
      },
    },
  },
});
