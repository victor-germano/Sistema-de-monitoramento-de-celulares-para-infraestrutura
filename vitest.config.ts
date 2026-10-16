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
    hookTimeout: 90_000,
    // Fase 4: com 10+ arquivos de integração subindo Postgres/Redis via
    // Testcontainers, o paralelismo TOTAL padrão do Vitest (todos os
    // arquivos ao mesmo tempo) estourava o `hookTimeout` na criação dos
    // containers, em máquina de desenvolvimento Windows/Docker Desktop.
    // Testado `maxThreads: 3` como meio-termo — não resolveu (o gargalo não
    // é memória do container em si: um `docker run postgres` isolado fica
    // pronto em ~1s mesmo com a máquina "carregada"; é overhead da própria
    // orquestração do Testcontainers — criação de rede, sessão do Ryuk,
    // port binding — quando várias rodam ao mesmo tempo contra a API do
    // Docker Desktop/WSL2). `fileParallelism: false` (serial completo) é o
    // que efetivamente funciona aqui: mais lento no total, mas
    // determinístico. Em CI (runners Linux, sem a camada WSL2) isso tende a
    // ter bem mais folga — reavaliar paralelismo lá se o tempo de CI
    // incomodar, não replicar esta config às cegas.
    fileParallelism: false,
    // Achado no CI real (não reproduz localmente sem `--coverage`, que muda
    // o timing): bug conhecido e ainda aberto do próprio Vitest 4/5
    // (vitest-dev/vitest#11153) — o worker intercepta console.log via RPC
    // pro processo principal, e um log tardio bem na hora do teardown do
    // worker vira `EnvironmentTeardownError` não tratado, mesmo com todos os
    // testes passando (328/328, nenhum teste falhou de verdade). Intermitente
    // e sem causa raiz confirmada pelos mantenedores do Vitest ainda.
    // Desligar a interceptação manda o console direto pro stdout — perde o
    // prefixo "de qual arquivo veio" nos logs de teste, mas elimina a
    // corrida (mesmo workaround usado por outros projetos que bateram nisso).
    disableConsoleIntercept: true,
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
      // RBAC (`src/plugins/rbac.ts`), o invariante de apps não-removíveis
      // (`src/domain/policy/policy-invariants.ts`, Fase 3) e, a partir da
      // Fase 4, os mappers da AMAPI (`src/integrations/amapi/mappers.ts`) —
      // agora consumidos por handlers reais (`ENROLLMENT`/`STATUS_REPORT`).
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
        'src/integrations/amapi/mappers.ts': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
      },
    },
  },
});
