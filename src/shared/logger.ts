import pino, { type LoggerOptions } from 'pino';
import { env } from '../config/env.ts';

// Redaction de dados sensíveis desde o primeiro commit — seção 11 da spec é
// explícita: IMEI, serial, ICCID, número de linha, tokens e headers de
// autorização nunca podem aparecer em log. Os campos de domínio (imei,
// serial, iccid, numero) ainda não existem em nenhum objeto logado nesta
// fase; os paths abaixo cobrem o que já existe (headers HTTP) e ficam como
// contrato vivo — cada novo campo sensível introduzido nas próximas fases
// entra nesta lista antes de ser logado pela primeira vez, não depois.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.authorization',
  '*.password',
  '*.token',
  '*.refreshToken',
  '*.imei',
  '*.serial',
  '*.iccid',
  '*.numero',
];

// Exportamos as *opções*, não só a instância: o Fastify precisa construir o
// logger internamente a partir de `LoggerOptions` (`Fastify({ logger: ... })`)
// em vez de receber uma instância pino pronta via `loggerInstance` — passar
// a instância pronta faz o TypeScript inferir o tipo exato do pino (com
// métodos específicos como `msgPrefix`) para o `FastifyInstance` retornado,
// o que quebra a atribuição desse valor ao tipo genérico `FastifyInstance`
// usado no resto do código (health.routes.ts, problem-details.ts). Com
// `logger: loggerOptions`, o Fastify cria o pino por baixo dos panos mas o
// tipo público da instância continua o `FastifyBaseLogger` padrão.
export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  // Em produção, JSON puro (consumido por agregador de log). Em dev, saída
  // legível via pino-pretty — só carregada como transport em dev pra não
  // virar dependência de runtime em produção.
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        }
      : undefined,
};

// Instância standalone para contextos fora do Fastify: bootstrap do
// servidor antes do `app` existir, encerramento gracioso, e futuramente
// workers (Pub/Sub, BullMQ) que não têm request HTTP nenhuma.
export const logger = pino(loggerOptions);
