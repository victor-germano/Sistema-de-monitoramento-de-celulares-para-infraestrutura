import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

// drizzle-kit roda fora do bootstrap da aplicação (é uma CLI separada), por
// isso lê `DATABASE_URL` direto do `.env` via `dotenv/config`, sem passar
// pelo `src/config/env.ts` (que traz validação/side-effects que não fazem
// sentido pra uma ferramenta de CLI).
export default defineConfig({
  dialect: 'postgresql',
  // O schema real (tabelas da seção 6 da spec) chega na Fase 2. Por ora
  // aponta para o placeholder em src/db/schema, só pra a CLI ter um alvo
  // válido e o pipeline de migrations já ficar configurado desde a Fase 1.
  schema: './src/db/schema/*.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/mdm',
  },
  strict: true,
  verbose: true,
});
