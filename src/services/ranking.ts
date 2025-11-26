import type { SearchInput } from '../types/search.js'
import type { SearchResult } from './browser-cash.js'

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

/**
 * Format raw browser results into a structured SERP response
 */
export function rankAndFormat(params: SearchInput, raw: RawResults): FormattedResponse {
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
