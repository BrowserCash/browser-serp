import 'dotenv/config'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { searchRoute } from './routes/search.js'
import { loadEnvNumber, loadEnvString, loadEnvStringList } from './env.js'
import { createSerpClient } from './services/browser-cash.js'

const PORT = loadEnvNumber('PORT', 8080)
const RATE_LIMIT_MAX = loadEnvNumber('RATE_LIMIT_MAX', 100)
const ALLOWED_ORIGINS = loadEnvStringList('ALLOWED_ORIGINS', ['*'])
const POOL_SIZE = loadEnvNumber('SERP_POOL_SIZE', 3)

async function buildServer() {
  const app = Fastify({
    logger: { level: loadEnvString('LOG_LEVEL', 'info') },
  })

  const serpClient = createSerpClient({ mode: 'pool', poolSize: POOL_SIZE })
  await serpClient.init()

  await app.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  })

  // CORS handler
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin

    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      reply.header('access-control-allow-origin', origin || '*')
      reply.header('access-control-allow-headers', req.headers['access-control-request-headers'] || '*')
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS')
    }

    if (req.method === 'OPTIONS') {
      return reply.send()
    }
  })

  // Health check endpoint
  app.get('/health', async () => ({ ok: true }))

  // Pool stats endpoint (useful for monitoring)
  app.get('/stats', async () => {
    const stats = 'stats' in serpClient ? (serpClient as any).stats() : null
    return { pool: stats }
  })

  // Search API route
  app.register(searchRoute, { prefix: '/api/v1', serpClient })

  // Cleanup on shutdown
  app.addHook('onClose', async () => {
    app.log.info('Closing browser sessions...')
    await serpClient.shutdown()
    app.log.info('All browser sessions closed')
  })

  return { app, serpClient }
}

async function main() {
  const { app, serpClient } = await buildServer()

  // Graceful shutdown handler
  let isShuttingDown = false

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    app.log.info({ signal }, 'Received shutdown signal, closing gracefully...')

    try {
      // Close Fastify server (stops accepting new requests)
      await app.close()
      app.log.info('Server closed successfully')
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown')
      // Force close browser sessions even if Fastify close failed
      await serpClient.shutdown().catch(() => {})
    }

    process.exit(0)
  }

  // Register signal handlers
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))   // Ctrl+C
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM')) // kill command
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'))   // terminal closed

  // Handle uncaught errors - still try to cleanup
  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err)
    await serpClient.shutdown().catch(() => {})
    process.exit(1)
  })

  process.on('unhandledRejection', async (reason) => {
    console.error('Unhandled rejection:', reason)
    await serpClient.shutdown().catch(() => {})
    process.exit(1)
  })

  await app.listen({ port: PORT, host: '0.0.0.0' })
  app.log.info({ port: PORT, poolSize: POOL_SIZE }, 'SERP API listening')
  app.log.info('Press Ctrl+C to shutdown gracefully')
}

main().catch(async (err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
