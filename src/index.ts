import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { searchRoute } from './routes/search.js';
import { loadEnvNumber, loadEnvString, loadEnvStringList } from './env.js';
import { createSerpClient, type SerpClient } from './services/serp.js';

const PORT = loadEnvNumber('PORT', 8080);
const RATE_LIMIT_MAX = loadEnvNumber('RATE_LIMIT_MAX', 100);
const ALLOWED_ORIGINS = loadEnvStringList('ALLOWED_ORIGINS', ['*']);
const POOL_SIZE = loadEnvNumber('SERP_POOL_SIZE', 3);

async function buildServer(serpClient: SerpClient) {
  const app = Fastify({
    logger: { level: loadEnvString('LOG_LEVEL', 'info') },
  });

  await app.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: '1 minute',
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
  await app.register(searchRoute, { prefix: '/api/v1', serpClient });

  // Cleanup on close
  app.addHook('onClose', async () => {
    app.log.info('Closing browser sessions...');
    await serpClient.shutdown();
    app.log.info('All browser sessions closed');
  });

  return app;
}

async function main() {
  // Initialize pool
  const serpClient = createSerpClient({ poolSize: POOL_SIZE });
  await serpClient.init();

  // Build and start server
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
  app.log.info({ port: PORT, poolSize: POOL_SIZE }, 'SERP API listening');
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
