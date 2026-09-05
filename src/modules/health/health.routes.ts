import type { FastifyInstance } from 'fastify';
import { checkDatabaseConnection } from '../../db/client.js';
import { checkRedisConnection } from '../../shared/redis-client.js';

export interface HealthCheck {
  status: 'up' | 'down';
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: {
    database: HealthCheck;
    redis: HealthCheck;
    // AMAPI entra na Fase 3, quando o client autenticado existir. Deixar o
    // campo de fora agora em vez de simular "up" — um health check que
    // finge checar algo que não existe é pior que não reportar o campo.
  };
  timestamp: string;
}

export function registerHealthRoutes(app: FastifyInstance): void {
  // Liveness + readiness combinados nesta única rota, como pede a seção 10.
  // Sem autenticação (rota pública, junto com /auth/*).
  app.get('/health', async (_request, reply) => {
    const [databaseUp, redisUp] = await Promise.all([
      checkDatabaseConnection(),
      checkRedisConnection(),
    ]);

    const response: HealthResponse = {
      status: databaseUp && redisUp ? 'ok' : 'degraded',
      checks: {
        database: { status: databaseUp ? 'up' : 'down' },
        redis: { status: redisUp ? 'up' : 'down' },
      },
      timestamp: new Date().toISOString(),
    };

    // 200 só quando tudo está de pé; 503 sinaliza pro orquestrador (ou pro
    // load balancer) que esta instância não está pronta pra receber tráfego.
    return reply.status(response.status === 'ok' ? 200 : 503).send(response);
  });
}
