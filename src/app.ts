import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { env } from './config/env.js';
import { loggerOptions } from './shared/logger.js';
import { errorHandler } from './shared/problem-details.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';

// Fábrica em vez de instância no módulo top-level: os testes de integração
// precisam construir a app DEPOIS de setar as env vars dos containers do
// Testcontainers (ver test/integration/health.test.ts) — uma instância
// criada na importação do módulo já teria capturado a config errada.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions });

  // Validação/serialização de rotas via Zod entra em vigor globalmente aqui;
  // rotas futuras (Fase 2+) declaram schema Zod direto no `app.get/post(...)`
  // e ganham validação + doc do OpenAPI de graça, sem chamada extra.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  await app.register(helmet);
  await app.register(cors, {
    origin: env.ALLOWED_ORIGINS.length > 0 ? env.ALLOWED_ORIGINS : false,
  });
  // Rate limit global conservador nesta fase (só /health existe). A seção 11
  // pede rate limit específico nas rotas de comando — esse limite mais
  // apertado é configurado por rota a partir da Fase 5, quando elas existirem.
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Sistema de Monitoramento de Celulares — API interna',
        description:
          'Backend de gestão de dispositivos móveis corporativos (EMM/MDM) sobre a Android Management API.',
        version: '0.1.0',
      },
      servers: [{ url: '/api/v1' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerHealthRoutes(app);

  return app;
}
