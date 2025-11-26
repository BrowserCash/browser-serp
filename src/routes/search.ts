import type { FastifyInstance } from 'fastify'
import { searchSchema, type SearchInput } from '../types/search.js'
import { rankAndFormat } from '../services/ranking.js'
import type { SerpClient } from '../services/browser-cash.js'

interface SearchRouteOptions {
  serpClient: SerpClient
}

export async function searchRoute(app: FastifyInstance, opts: SearchRouteOptions): Promise<void> {
  app.post('/search', async (req, reply) => {
    const start = Date.now()

    const parsed = searchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        details: parsed.error.flatten(),
      })
    }

    const params: SearchInput = parsed.data

    try {
      const rawResults = await opts.serpClient.search(params)
      const response = rankAndFormat(params, rawResults)
      console.log('[search] done', { ms: Date.now() - start, results: rawResults.results.length })
      return reply.send(response)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'failed to fetch SERP'
      req.log.error({ err }, 'search failed')
      console.error('[search] failed', { ms: Date.now() - start, error: message })
      return reply.status(502).send({
        error: 'upstream_error',
        message,
      })
    }
  })
}
