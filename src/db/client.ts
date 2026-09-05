import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

// `max: 10` é um teto conservador pra um serviço interno de infraestrutura
// (não uma API pública de alto tráfego). Revisamos se o pool virar gargalo
// quando os dashboards (Fase 6) começarem a fazer queries agregadas pesadas.
export const sql = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(sql, { schema });

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
