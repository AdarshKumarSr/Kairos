import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { loadConfig, type Config } from '@cex/config';
import { prisma, type PrismaClient } from '@cex/db';
import { logApiRequest, logError, printStartupBanner } from '@cex/logger';
import { AppError } from './errors/app-error.js';
import { requireRole } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { tradingRoutes } from './routes/trading.js';
import { docsRoutes } from './docs/openapi.js';
import { EngineClient } from './engine/engine-client.js';
import { MarketConfigCache } from './services/market-config-cache.js';

declare module 'fastify' {
  interface FastifyInstance {
    gatewayConfig: Config;
    prisma: PrismaClient;
    redis: Redis;
    registeredRoutes: Array<{ method: string; path: string }>;
    engineClient: EngineClient;
    marketConfigCache: MarketConfigCache;
  }
}

export interface GatewayDependencies {
  prisma?: PrismaClient;
  redis?: Redis;
  engineClient?: EngineClient;
  marketConfigCache?: MarketConfigCache;
}

export async function buildApp(config: Config = loadConfig(), dependencies: GatewayDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, genReqId: () => randomUUID() });
  const redis = dependencies.redis ?? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  const registeredRoutes: Array<{ method: string; path: string }> = [];

  const engineClient =
    dependencies.engineClient ??
    new EngineClient({
      redisUrl: config.REDIS_URL,
      maxQueueLen: config.MAX_QUEUE_LEN,
    });

  const marketConfigCache =
    dependencies.marketConfigCache ??
    new MarketConfigCache(dependencies.prisma ?? prisma, redis);
  await marketConfigCache.init();

  app.decorate('gatewayConfig', config);
  app.decorate('prisma', dependencies.prisma ?? prisma);
  app.decorate('redis', redis);
  app.decorate('registeredRoutes', registeredRoutes);
  app.decorate('engineClient', engineClient);
  app.decorate('marketConfigCache', marketConfigCache);

  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const method of methods) {
      if (method !== 'HEAD') {
        registeredRoutes.push({ method, path: routeOptions.url });
      }
    }
  });

  await app.register(cors, { origin: config.CORS_ORIGINS.split(',').map((origin) => origin.trim()), credentials: true });
  await app.register(helmet);
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_ACCESS_SECRET });
  await app.register(rateLimit, { global: false, redis, keyGenerator: (request) => request.ip });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', details: error.flatten() } });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts.', details: {} } });
    }
    logError(error, { requestId: request.id, service: 'api-gateway' });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.', details: {} } });
  });

  app.addHook('onResponse', async (request, reply) => {
    logApiRequest({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
      requestId: request.id,
      ip: request.ip,
    });
  });

  app.get('/api/v1/healthz', async () => {
    await app.prisma.$queryRawUnsafe('SELECT 1');
    await app.redis.ping();
    return { status: 'ok' };
  });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(tradingRoutes, { prefix: '/api/v1' });
  app.get('/api/v1/admin/test', { preHandler: requireRole('ADMIN') }, async () => ({ ok: true }));

  if (config.NODE_ENV !== 'production') {
    await app.register(docsRoutes);
  }

  app.addHook('onClose', async () => {
    if (!dependencies.engineClient) await engineClient.close();
    if (!dependencies.redis) await redis.quit();
  });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = await buildApp();
  const port = app.gatewayConfig.API_PORT;
  const host = '0.0.0.0';
  await app.listen({ host, port });

  let dbStatus: 'connected' | 'error' = 'connected';
  let redisStatus: 'connected' | 'error' = 'connected';
  try {
    await app.prisma.$queryRawUnsafe('SELECT 1');
  } catch {
    dbStatus = 'error';
  }
  try {
    await app.redis.ping();
  } catch {
    redisStatus = 'error';
  }

  printStartupBanner({
    serviceName: '@cex/api-gateway',
    title: '🚀 KAIROS CEX : API GATEWAY',
    environment: app.gatewayConfig.NODE_ENV,
    host,
    port,
    baseUrl: `http://localhost:${port}`,
    healthUrl: `http://localhost:${port}/api/v1/healthz`,
    dependencies: [
      { name: 'PostgreSQL 16 (TimescaleDB)', status: dbStatus },
      { name: 'Redis 7', status: redisStatus },
    ],
    routes: app.registeredRoutes,
  });
}
