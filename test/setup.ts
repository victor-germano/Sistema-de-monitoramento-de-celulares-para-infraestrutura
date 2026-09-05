// Roda antes de cada arquivo de teste (ver `test` config em vitest.config.ts).
// `src/config/env.ts` faz `process.exit(1)` no import se DATABASE_URL/
// REDIS_URL não existirem — necessário em produção (falha rápido e claro em
// vez de quebrar obscuro no primeiro request), mas quebraria qualquer teste
// unitário que só precise importar algo de `env.ts` sem ter subido
// containers de verdade. `??=` para não sobrescrever o que um teste de
// integração específico já tenha setado antes (ex.: URLs reais de
// Testcontainers em `test/integration/health.test.ts`, que roda seu próprio
// `beforeAll` antes de importar a aplicação).
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
