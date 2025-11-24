import { request } from 'undici'
import { loadEnvString } from '../lib/env.js'

const BROWSER_CASH_API_KEY = loadEnvString('BROWSER_CASH_API_KEY')
const BROWSER_CASH_BASE = loadEnvString('BROWSER_CASH_BASE', 'https://browser-api.browser.cash')

// Minimal stub to dispatch a search through browser.cash.
// This is intentionally simplified; wire to your actual runner/agent endpoints.
export async function dispatchBrowserQuery(params: {
  q: string
  country?: string
  search_lang?: string
  count: number
  freshness?: 'day' | 'week' | 'month' | 'year'
  safesearch?: 'off' | 'moderate' | 'strict'
}) {
  const body = {
    query: params.q,
    country: params.country,
    lang: params.search_lang,
    count: params.count,
    freshness: params.freshness,
    safesearch: params.safesearch,
  }

  const res = await request(`${BROWSER_CASH_BASE}/v1/consumer/session`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${BROWSER_CASH_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (res.statusCode >= 400) {
    const text = await res.body.text()
    throw new Error(`browser.cash upstream ${res.statusCode}: ${text}`)
  }

  const json = await res.body.json()
  // TODO: parse actual SERP payload from your runner; returning placeholder shape.
  return json
}
