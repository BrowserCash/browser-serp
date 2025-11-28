import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SerpClient, SearchResult } from '../services/serp.js'

const DEBUG_LOG = process.env.SERP_DEBUG_LOG === "1" || process.env.SERP_DEBUG_LOG === "true"

const searchSchema = z.object({
  q: z.string().min(1),
  count: z.number().int().min(1).max(100).default(10),
  country: z.string().min(2).max(10).optional(),
  search_lang: z.string().optional(),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  safesearch: z.enum(['off', 'moderate', 'strict']).optional(),
})

type SearchInput = z.infer<typeof searchSchema>

interface SearchRouteOptions {
  serpClient: SerpClient
}

interface RawResults {
  results: SearchResult[]
}

interface FormattedResponse {
  type: 'search'
  query: {
    original: string
    show_strict_warning: boolean
  }
  web: {
    results: SearchResult[]
    family_friendly: boolean
  }
  mixed: {
    type: 'mixed'
    main: SearchResult[]
    top: SearchResult[]
    side: SearchResult[]
  }
}

function rankAndFormat(params: SearchInput, raw: RawResults): FormattedResponse {
  const results = raw.results ?? []

  return {
    type: 'search',
    query: {
      original: params.q,
      show_strict_warning: false,
    },
    web: {
      results,
      family_friendly: (params.safesearch ?? 'moderate') !== 'off',
    },
    mixed: {
      type: 'mixed',
      main: results.slice(0, Math.min(3, results.length)),
      top: [],
      side: [],
    },
  }
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
      if (DEBUG_LOG) console.log('[search] done', { ms: Date.now() - start, results: rawResults.results.length })
      return reply.send(response)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'failed to fetch SERP'
      req.log.error({ err }, 'search failed')
      if (DEBUG_LOG) console.error('[search] failed', { ms: Date.now() - start, error: message })
      return reply.status(502).send({
        error: 'upstream_error',
        message,
      })
    }
  })
}
