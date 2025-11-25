import 'dotenv/config'
import Fastify from 'fastify'
import rateLimit, { type RateLimitPluginOptions } from '@fastify/rate-limit'
import { searchRoute } from './routes/search.js'
import { loadEnvNumber, loadEnvString, loadEnvStringList } from './lib/env.js'

const PORT = loadEnvNumber('PORT', 8080)
const RATE_LIMIT_MAX = loadEnvNumber('RATE_LIMIT_MAX', 10)
const RATE_LIMIT_WINDOW = loadEnvString('RATE_LIMIT_TIME_WINDOW', '1 minute')
const ALLOWED_ORIGINS = loadEnvStringList('ALLOWED_ORIGINS', ['*'])

async function buildServer() {
  const app = Fastify({
    logger: { level: loadEnvString('LOG_LEVEL', 'info') },
  })

  await app.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW,
  } as RateLimitPluginOptions)

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      reply.header('access-control-allow-origin', origin || '*')
      reply.header('access-control-allow-headers', req.headers['access-control-request-headers'] || '*')
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS')
    }
    if (req.method === 'OPTIONS') return reply.send()
  })

  app.get('/health', async () => ({ ok: true }))
  app.register(searchRoute, { prefix: '/api/v1' })

  return app
}

async function main() {
  const app = await buildServer()
  await app.listen({ port: PORT, host: '0.0.0.0' })
  app.log.info({ port: PORT }, 'SERP API listening')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
