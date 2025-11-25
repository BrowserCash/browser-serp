import { chromium } from 'patchright-core'
import { request } from 'undici'
import { loadEnvString } from '../lib/env.js'
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'

const BROWSER_CASH_API_KEY = loadEnvString('BROWSER_CASH_API_KEY')
// Public API host that fronts browser + agent endpoints.
const BROWSER_CASH_BASE = loadEnvString('BROWSER_CASH_BASE', 'https://api.browser.cash')
const DEBUG_HTML = process.env.SERP_DEBUG_HTML === '1' || process.env.SERP_DEBUG_HTML === 'true'
const DEBUG_LOG = process.env.SERP_DEBUG_LOG === '1' || process.env.SERP_DEBUG_LOG === 'true'

type SearchParams = {
  q: string
  country?: string
  search_lang?: string
  count: number
  freshness?: 'day' | 'week' | 'month' | 'year'
  safesearch?: 'off' | 'moderate' | 'strict'
}

type SessionResponse = {
  sessionId: string
  status: string
  servedBy?: string
  createdAt?: string
  stoppedAt?: string | null
  cdpUrl?: string | null
}

async function httpJson<T>(path: string, opts: { method?: string; body?: any; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await request(`${BROWSER_CASH_BASE}${path}`, {
    method: opts.method as any || 'GET',
    headers: {
      authorization: `Bearer ${BROWSER_CASH_API_KEY}`,
      'content-type': 'application/json',
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.body.text()
  if (res.statusCode >= 400) {
    throw new Error(`browser.cash ${res.statusCode}: ${text}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`browser.cash parse error: ${text}`)
  }
}

async function createSession(): Promise<SessionResponse> {
  return httpJson<SessionResponse>('/v1/browser/session', { method: 'POST', body: {} })
}

async function getSession(sessionId: string): Promise<SessionResponse> {
  return httpJson<SessionResponse>(`/v1/browser/session?sessionId=${encodeURIComponent(sessionId)}`)
}

async function stopSession(sessionId: string): Promise<void> {
  try {
    await httpJson('/v1/browser/session?sessionId=' + encodeURIComponent(sessionId), { method: 'DELETE' })
  } catch {
    // Swallow cleanup errors to avoid masking the primary failure
  }
}

async function waitForActiveSession(sessionId: string, timeoutMs = 20_000): Promise<SessionResponse> {
  const start = Date.now()
  let last: SessionResponse | null = null
  while (Date.now() - start < timeoutMs) {
    last = await getSession(sessionId)
    if (last.status === 'active' && last.cdpUrl) return last
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out waiting for session ${sessionId} to become active`)
}

function dumpHtml(html: string, label: string) {
  if (!DEBUG_HTML) return
  try {
    const outPath = path.join(process.cwd(), `serp-debug-${label}.html`)
    fs.writeFileSync(outPath, html, 'utf8')
    console.log(`[serp-debug] wrote ${outPath} (${html.length} bytes)`)
  } catch (err) {
    console.error('[serp-debug] failed to write html dump', err)
  }
}

function extractJsonArray(text: string): any[] | null {
  try {
    return JSON.parse(text);
  } catch {}
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first !== -1 && last !== -1 && last > first) {
    const slice = text.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }
  return null;
}

async function runGoogleSearch(page: any, params: SearchParams): Promise<{ results: any[]; blocked: boolean }> {
  const count = Math.min(Math.max(params.count ?? 10, 1), 20)
  const hl = params.search_lang || 'en'
  const gl = params.country ? params.country.toLowerCase() : undefined
  const query = encodeURIComponent(params.q)
  const baseUrl = `https://www.google.com/search?q=${query}&num=${count}&hl=${encodeURIComponent(hl)}${gl ? `&gl=${encodeURIComponent(gl)}` : ''}&safe=off`

  // Bias Google toward the classic HTML layout and English responses.
  try {
    await page.context().setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    })
  } catch {
    // ignore header set failures
  }

  const parseResults = async (): Promise<{ title: string; url: string; description: string; position: number }[]> => {
    // Capture HTML and offload parsing to OpenRouter to be resilient to DOM tweaks
    const html = await page.content().catch(() => '')
    if (html) dumpHtml(html, 'google-parsed')

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      console.error('[serp-parser] OPENROUTER_API_KEY not set; returning empty results')
      return []
    }

    try {
        const prompt = `
You are a DOM parser. Extract up to ${params.count} web search results from the HTML of a Google SERP.
For each result, return: title, url, description, position (starting at 1).
Ignore non-result cards (people also ask, images, videos).
Always respond with valid JSON (no markdown fences). Use this shape:
{
  "reasoning": "<brief reasoning of how you parsed the page>",
  "results": [
    {"title":"...","url":"https://...","description":"...","position":1},
    ...
  ]
}
If no results are found, still return the object with an empty array and a reasoning string.`

        const resp = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'x-ai/grok-4.1-fast',
            messages: [
              { role: 'system', content: 'You extract structured search results from HTML.' },
              { role: 'user', content: `${prompt}\n\nHTML (full):\n${html}` },
            ],
            max_tokens: 1200,
          temperature: 0,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      )
      let text = resp.data?.choices?.[0]?.message?.content || '[]'
      if (DEBUG_LOG) console.log('[serp-parser] raw llm', { len: text.length, preview: text.slice(0, 200) })
      text = text.trim()
      if (text.startsWith('```')) {
        const parts = text.split('```')
        if (parts.length >= 3) {
          text = parts[1].trim()
          if (text.startsWith('json')) text = text.slice(4).trim()
        }
      }
      let parsed: any = null
      try {
        parsed = JSON.parse(text)
      } catch {
        const arr = extractJsonArray(text)
        if (arr) parsed = { results: arr }
      }
      let reasoning: string | undefined
      let arr: any[] | undefined
      if (parsed) {
        if (Array.isArray(parsed)) {
          arr = parsed
        } else if (Array.isArray(parsed.results)) {
          arr = parsed.results
        }
        reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined
      }
      if (DEBUG_LOG) console.log('[serp-parser] parsed array length', arr ? arr.length : 'null', 'reasoning', reasoning || 'n/a')
      if (arr && Array.isArray(arr)) {
        const out = arr
          .filter((r) => r && typeof r.title === 'string' && typeof r.url === 'string' && r.url.startsWith('http'))
          .map((r, idx) => ({
            title: String(r.title).trim(),
            url: String(r.url).trim(),
            description: String(r.description || '').trim(),
            position: Number(r.position) > 0 ? Number(r.position) : idx + 1,
          }))
        if (out.length) return out
      }
    } catch (err: any) {
      const msg = typeof err?.message === 'string' ? err.message : String(err || '')
      console.error('[serp-parser] openrouter failed', msg)
    }

    // If LLM gave nothing, return empty results
    return []
  }

  const fetchAndParse = async (url: string, tag: string) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    await page.waitForSelector('div#search', { timeout: 8_000 }).catch(() => {})
    const html = await page.content().catch(() => '')
    if (html) dumpHtml(html, tag)
    return parseResults()
  }

  let results = await fetchAndParse(baseUrl, 'google-base')
  let lastHtml = await page.content().catch(() => '')

  // Fallback to simplified HTML view if nothing came back (e.g., consent page/JS blocked)
  if (!results.length) {
    const fallbackUrl = `${baseUrl}&gbv=1`
    results = await fetchAndParse(fallbackUrl, 'google-fallback')
    lastHtml = await page.content().catch(() => lastHtml)
  }

  // If still empty and we hit a CAPTCHA/blocked page, we'll flag it
  const blocked = (!results.length) && /captcha-form|recaptcha|unusual traffic/i.test(lastHtml || '')

  return { results: results.slice(0, count), blocked }
}

// Dispatch a search by:
// 1) creating a Browser.cash session
// 2) waiting for CDP to be ready
// 3) connecting via CDP and fetching a Google SERP
// 4) cleaning up the session
export async function dispatchBrowserQuery(params: SearchParams) {
  const t0 = Date.now()
  if (DEBUG_LOG) console.log('[serp] start', { q: params.q, count: params.count, lang: params.search_lang, country: params.country })
  const session = await createSession()
  const sessionId = session.sessionId
  if (DEBUG_LOG) console.log('[serp] session created', { sessionId })
  let browser: any | null = null

  try {
    const activeSession = await waitForActiveSession(sessionId)
    if (DEBUG_LOG) console.log('[serp] session active', { sessionId })
    if (!activeSession.cdpUrl) throw new Error('No CDP URL returned for session')

    browser = await chromium.connectOverCDP(activeSession.cdpUrl)
    const context = browser.contexts()[0] || (await browser.newContext())
    const page = context.pages()[0] || (await context.newPage())
    if (DEBUG_LOG) console.log('[serp] connected to cdp', { sessionId })

    const g = await runGoogleSearch(page, params)
    const results = g.results
    if (DEBUG_LOG) console.log('[serp] fetched', { sessionId, results: results?.length, blocked: g.blocked, ms: Date.now() - t0 })
    await browser.close().catch(() => {})
    browser = null
    return { results }
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
    await stopSession(sessionId)
    if (DEBUG_LOG) console.log('[serp] session closed', { sessionId, ms: Date.now() - t0 })
  }
}
