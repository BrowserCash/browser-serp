import type { z } from 'zod'
import type { inferRouterInputs } from '../types/search.js'

type SearchParams = inferRouterInputs['search']

// Placeholder: transform raw browser output into SERP-like response
export function rankAndFormat(params: SearchParams, raw: any) {
  const results = (raw?.results as any[] | undefined) ?? []

  // TODO: implement ranking/scoring; for now, return passthrough structure
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
