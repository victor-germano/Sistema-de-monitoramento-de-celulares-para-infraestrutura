import { buildApp } from './app.ts';
import { env } from './config/env.ts';
import { logger } from './shared/logger.ts';
import { sql } from './db/client.ts';
import { redis } from './shared/redis-client.ts';

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
