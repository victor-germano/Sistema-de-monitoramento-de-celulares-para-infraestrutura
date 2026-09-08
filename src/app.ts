import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { env } from './config/env.ts';
import { loggerOptions } from './shared/logger.ts';
import { errorHandler } from './shared/problem-details.ts';
import { registerHealthRoutes } from './modules/health/health.routes.ts';
import authPlugin from './plugins/auth.ts';
import rbacPlugin from './plugins/rbac.ts';
import { registerAuthRoutes } from './modules/auth/auth.routes.ts';
import { registerDeviceRoutes } from './modules/devices/devices.routes.ts';
import { registerInternalRoutes } from './modules/internal/internal.routes.ts';
import { registerAuditoriaRoutes } from './modules/auditoria/auditoria.routes.ts';
import { registerPoliticaRoutes } from './modules/politicas/politicas.routes.ts';
import { registerColaboradorRoutes } from './modules/colaboradores/colaboradores.routes.ts';
import { registerLinhaRoutes } from './modules/linhas/linhas.routes.ts';
import { registerAlertaRoutes } from './modules/alertas/alertas.routes.ts';
import { registerDashboardRoutes } from './modules/dashboard/dashboard.routes.ts';

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
    // Refresh token viaja via cookie httpOnly (ver ADR-010) — sem
    // `credentials: true` o browser nem envia esse cookie em requisições
    // cross-origin do frontend (que roda numa origem diferente da API).
    credentials: true,
  });
  await app.register(cookie);
  // Rate limit global conservador. `POST /devices/:id/comandos` (Fase 5)
  // tem um limite adicional, mais apertado, configurado só naquela rota
  // (`config.rateLimit`, seção 11) — os dois se aplicam juntos ali.
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

  // Ordem importa a partir daqui: `rbacPlugin` registra o hook `onRoute`
  // que alimenta `routeAccessRegistry` — só pega rotas registradas DEPOIS
  // dele. `authPlugin` decora `request.user`, lido pelo `preHandler` que
  // `withRole(...)` monta. Os dois precisam existir ANTES de qualquer
  // `register*Routes(app)`.
  await app.register(rbacPlugin);
  await app.register(authPlugin);

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerDeviceRoutes(app);
  registerInternalRoutes(app);
  registerAuditoriaRoutes(app);
  registerPoliticaRoutes(app);
  registerColaboradorRoutes(app);
  registerLinhaRoutes(app);
  registerAlertaRoutes(app);
  registerDashboardRoutes(app);

  return app;
}
