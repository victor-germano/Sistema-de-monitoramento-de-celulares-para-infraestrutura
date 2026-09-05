import { z } from 'zod';

// Fonte única de verdade das variáveis de ambiente desta fase. Cresce junto
// com o projeto: cada fase adiciona só os campos que o código daquela fase
// efetivamente consome — variáveis de fases futuras já documentadas no
// `.env.example`, mas só entram aqui quando o código que as usa existir.
// Isso evita declarar como "obrigatória" uma env var que nada lê ainda.
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Lista separada por vírgula -> array. Vazio vira lista vazia (CORS fechado),
  // nunca `undefined`, pra `@fastify/cors` ter sempre um valor determinístico.
  ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
});

export type Env = z.infer<typeof envSchema>;

// Parse eager (no import do módulo, não sob demanda): preferimos falhar o
// boot imediatamente com uma mensagem clara de qual variável está errada a
// deixar a aplicação subir e quebrar de forma obscura no primeiro request
// que tocar a variável faltante. Efeito colateral: em teste, quem importa
// `app.ts`/`env.ts` precisa ter as env vars setadas ANTES do import (import
// dinâmico) — ver test/integration/health.test.ts.
function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const detalhes = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error(`Configuração de ambiente inválida:\n${detalhes}`);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
