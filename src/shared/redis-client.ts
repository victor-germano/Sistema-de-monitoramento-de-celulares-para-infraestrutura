// Import nomeado, não default: o pacote expõe os dois, mas o default export
// via `export { default } from './Redis'` não interopera de forma confiável
// com `moduleResolution: NodeNext` (o import resolve pro namespace do módulo
// em vez da classe, e vira "not constructable"). O named export não sofre
// desse problema.
import { Redis } from 'ioredis';
import { env } from '../config/env.ts';

// Cliente singleton. BullMQ (Fase 3+) e o motor de alertas (Fase 6) vão
// reusar esta mesma instância em vez de abrir conexões próprias — mantém um
// único pool de conexões Redis por processo.
export const redis = new Redis(env.REDIS_URL, {
  // BullMQ recomenda null aqui; para o uso genérico (health check, cache)
  // mantemos o retry padrão do ioredis.
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

export async function checkRedisConnection(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
