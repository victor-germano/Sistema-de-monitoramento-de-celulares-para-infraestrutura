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
    .transform((value) => splitList(value)),

  // --- Autenticação corporativa (Fase 2) -------------------------------
  // Emissor OIDC. Trocar de Google Workspace pra Microsoft Entra ID exige
  // só mudar OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET (ver ADR-003) — o código
  // decide qual `OidcDomainValidator` usar a partir do próprio issuer, sem
  // env var extra pra "qual provedor é este".
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_REDIRECT_URI: z.string().url(),
  // URL do frontend pra onde `/auth/callback` redireciona depois do login
  // (seção 10 não detalha o contrato de resposta do callback — decisão
  // registrada em ADR-010).
  FRONTEND_URL: z.string().url(),
  // Domínios aceitos no login, separados por vírgula — pelo menos um.
  ALLOWED_EMAIL_DOMAINS: z
    .string()
    .min(1, 'ALLOWED_EMAIL_DOMAINS precisa de pelo menos um domínio')
    .transform((value) => splitList(value)),
  // E-mails que recebem role ADMIN no primeiro login em vez de VIEWER —
  // resolve o problema do "primeiro ADMIN" (provisionamento JIT sempre cria
  // VIEWER; sem isso, ninguém nunca sairia de VIEWER). Opcional: lista vazia
  // é um valor válido (times que preferem promover manualmente via SQL no
  // primeiro setup).
  BOOTSTRAP_ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((value) => splitList(value)),

  // JWT interno de sessão + refresh token opaco (seção 5). Segredo mínimo de
  // 32 chars — não é uma regra arbitrária, é o mínimo recomendado pra HMAC
  // com HS256 não virar o elo fraco da assinatura.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres'),
  JWT_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(8),
});

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

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
