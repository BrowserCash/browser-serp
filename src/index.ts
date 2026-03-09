import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { serpSearchRoute } from './routes/serp-search.js';
import { loadEnvNumber, loadEnvString, loadEnvStringList } from './env.js';
import { createSerpClient, type SerpClient } from './services/serp.js';
import { validateApiKey } from './middleware/auth-cache.js';
import { fireBilling, hasCredit, MILLICENTS_PER_UNIT } from './middleware/billing.js';
import { fireLog } from './middleware/d1-logger.js';
import './middleware/types.js';

if (!globalThis.WebSocket) {
  // @ts-expect-error ws is API-compatible with browser WebSocket.
  globalThis.WebSocket = WebSocket;
}

const PORT = loadEnvNumber('PORT', 8080);
const RATE_LIMIT_MAX = loadEnvNumber('RATE_LIMIT_MAX', 100);
const ALLOWED_ORIGINS = loadEnvStringList('ALLOWED_ORIGINS', ['*']);

async function buildServer(serpClient: SerpClient) {
  const app = Fastify({
    logger: { level: loadEnvString('LOG_LEVEL', 'info') },
  });

  await app.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  });

  // Decorate request with auth/tracking fields
  app.decorateRequest('userContext', null);
  app.decorateRequest('requestId', '');
  app.decorateRequest('requestStartMs', 0);
  app.decorateRequest('resultCount', 0);
  app.decorateRequest('responsePayload', '');

  const requireAuth = process.env.REQUIRE_AUTH === 'true';

  // Auth
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health' || req.url === '/stats') return;
    req.requestId = randomUUID();
    req.requestStartMs = Date.now();

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      if (requireAuth) return reply.status(401).send({ message: 'Unauthorized', statusCode: 401 });
      return;
    }

    const key = authHeader.slice(7);
    const userContext = await validateApiKey(key);
    if (!userContext) {
      if (requireAuth) return reply.status(401).send({ message: 'Unauthorized', statusCode: 401 });
      return;
    }

    req.userContext = userContext;

    if (!hasCredit(userContext.orgId)) {
      return reply.status(402).send({ message: 'Insufficient credits', statusCode: 402 });
    }
  });

  // Capture response body before it's flushed
  app.addHook('onSend', (req, _reply, payload, done) => {
    req.responsePayload = typeof payload === 'string' ? payload.slice(0, 100_000) : '';
    done(null, payload);
  });

  // Billing + logging (fire-and-forget after response is flushed)
  app.addHook('onResponse', (req, reply, done) => {
    if (!req.userContext) { done(); return; }

    const millicents = MILLICENTS_PER_UNIT;
    const idem = `usage:browser-serp:${req.requestId}`;

    fireBilling(req.userContext.orgId, millicents, idem);

    const body = req.body as Record<string, unknown> | null;
    const queryOrUrl = typeof body?.q === 'string' ? body.q : null;

    fireLog({
      service: 'browser-serp',
      userContext: req.userContext,
      endpoint: req.url,
      queryOrUrl,
      statusCode: reply.statusCode,
      resultCount: req.resultCount,
      latencyMs: Date.now() - req.requestStartMs,
      requestBodyJson: body ? JSON.stringify(body).slice(0, 1000) : null,
      responseSummaryJson: req.responsePayload || null,
      billedMillicents: millicents,
      idempotencyKey: idem,
    });

    done();
  });

  // CORS
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;

    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      reply.header('access-control-allow-origin', origin || '*');
      reply.header('access-control-allow-headers', req.headers['access-control-request-headers'] || '*');
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    }

    if (req.method === 'OPTIONS') {
      return reply.send();
    }
  });

  // Health check
  app.get('/health', async () => ({ ok: true }));

  // Pool stats
  app.get('/stats', async () => ({ pool: serpClient.stats() }));

  // Search API
  await app.register(serpSearchRoute, { prefix: '/api/v1', serpClient });

  // Cleanup on close
  app.addHook('onClose', async () => {
    app.log.info('Closing browser sessions...');
    await serpClient.shutdown();
    app.log.info('All browser sessions closed');
  });

  return app;
}

async function main() {
  // Create client and start server first so platform health checks can pass
  // while the pool warms in the background.
  const serpClient = createSerpClient();
  const app = await buildServer(serpClient);

  // Graceful shutdown
  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info({ signal }, 'Received shutdown signal');

    try {
      await app.close();
      app.log.info('Server closed');
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      await serpClient.shutdown().catch(() => {});
    }

    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    await serpClient.shutdown().catch(() => {});
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('Unhandled rejection:', reason);
    await serpClient.shutdown().catch(() => {});
    process.exit(1);
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info({ port: PORT, pool: serpClient.stats() }, 'SERP API listening');

  void serpClient
    .init()
    .then(() => {
      app.log.info({ pool: serpClient.stats() }, 'SERP pool warmup complete');
    })
    .catch((err) => {
      app.log.error({ err }, 'SERP pool warmup failed');
    });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
