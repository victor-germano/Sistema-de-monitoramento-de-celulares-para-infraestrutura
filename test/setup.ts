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

// Fase 2 — mesma lógica: valores fixos e óbvios de teste, nunca lidos de
// verdade fora dos testes que especificamente exercitam OIDC de verdade
// (nenhum, por ora — ver ADR-005 e docs/SETUP.md sobre login corporativo
// ponta a ponta ser validação manual, não automatizada nesta fase).
process.env.OIDC_ISSUER ??= 'https://accounts.google.com';
process.env.OIDC_CLIENT_ID ??= 'test-client-id';
process.env.OIDC_CLIENT_SECRET ??= 'test-client-secret';
process.env.OIDC_REDIRECT_URI ??= 'http://localhost:3000/auth/callback';
process.env.FRONTEND_URL ??= 'http://localhost:5173';
process.env.ALLOWED_EMAIL_DOMAINS ??= 'gruporoveri.com.br';
process.env.JWT_SECRET ??= 'test-jwt-secret-com-pelo-menos-32-caracteres';

// Fase 3 — idem: nenhum teste chama a AMAPI de verdade (sem credenciais
// reais neste ambiente, ver ADR-005); a fronteira de rede é sempre mockada.
process.env.AMAPI_ENTERPRISE_NAME ??= 'enterprises/LC00000000000000000';
process.env.AMAPI_SERVICE_ACCOUNT_KEY_PATH ??= './test/fixtures/amapi-service-account.json';
