import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './shared/logger.js';
import { sql } from './db/client.js';
import { redis } from './shared/redis-client.js';

async function main(): Promise<void> {
  const app = await buildApp();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'servidor iniciado');

  // Encerramento gracioso: fecha o Fastify (drena requisições em voo) antes
  // de derrubar as conexões de banco/Redis, na ordem inversa da inicialização.
  // Importante em produção sob orquestrador (K8s manda SIGTERM antes de matar
  // o pod) e localmente em Ctrl+C.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'encerrando servidor');
    try {
      await app.close();
      await sql.end({ timeout: 5 });
      redis.disconnect();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'erro ao encerrar servidor');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'falha ao iniciar servidor');
  process.exit(1);
});
