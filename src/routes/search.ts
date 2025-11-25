import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { rankAndFormat } from '../services/ranking.js'
import type { SerpClient } from '../services/browser-cash.js'

const searchSchema = z.object({
  q: z.string().min(1),
  count: z.number().int().min(1).max(100).default(10),
  country: z.string().min(2).max(10).optional(),
  search_lang: z.string().optional(),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  safesearch: z.enum(['off', 'moderate', 'strict']).optional(),
})

export async function searchRoute(app: FastifyInstance, opts: { serpClient: SerpClient }) {
  app.post('/search', async (req, reply) => {
    const start = Date.now()
    const parsed = searchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', details: parsed.error.flatten() })
    }
    const params = parsed.data

    try {
      const rawResults = await opts.serpClient.search(params)
      const response = rankAndFormat(params, rawResults)
      console.log('[search] done', { ms: Date.now() - start, results: rawResults?.results?.length })
      return reply.send(response)
    } catch (err: any) {
      req.log.error({ err }, 'search failed')
      console.error('[search] failed', { ms: Date.now() - start, error: err?.message })
      return reply.status(502).send({ error: 'upstream_error', message: err?.message || 'failed to fetch SERP' })
    }
  })
}
