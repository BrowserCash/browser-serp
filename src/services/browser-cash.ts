import { chromium } from 'patchright-core'
import { request } from 'undici'
import { loadEnvString } from '../lib/env.js'
import fs from 'node:fs'
import path from 'node:path'

const BROWSER_CASH_API_KEY = loadEnvString('BROWSER_CASH_API_KEY')
// Public API host that fronts browser + agent endpoints.
const BROWSER_CASH_BASE = loadEnvString('BROWSER_CASH_BASE', 'https://api.browser.cash')

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
    method: opts.method || 'GET',
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

const DUMP_HTML = true
function dumpHtml(html: string, label: string) {
  if (!DUMP_HTML) return
  try {
    const outPath = path.join(process.cwd(), `serp-debug-${label}.html`)
    fs.writeFileSync(outPath, html, 'utf8')
    console.log(`[serp-debug] wrote ${outPath} (${html.length} bytes)`)
  } catch (err) {
    console.error('[serp-debug] failed to write html dump', err)
  }
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
    return await page.evaluate(() => {
      const items: { title: string; url: string; description: string; position: number }[] = []
      const nodes = Array.from(document.querySelectorAll<HTMLDivElement>('div#search div.g, div.g'))
      nodes.forEach((el, idx) => {
        const link = el.querySelector<HTMLAnchorElement>('a')
        const title = el.querySelector<HTMLHeadingElement>('h3')?.textContent?.trim()
        const href = link?.href?.trim()
        const desc =
          el.querySelector<HTMLElement>('div.VwiC3b')?.textContent?.trim() ||
          el.querySelector<HTMLElement>('span.aCOpRe')?.textContent?.trim() ||
          ''
        if (title && href && href.startsWith('http')) {
          items.push({ title, url: href, description: desc, position: idx + 1 })
        }
      })
      return items
    })
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

  // If still empty and we hit a CAPTCHA/blocked page, we'll signal upstream to try Bing
  const blocked = (!results.length) && /captcha-form|recaptcha|unusual traffic/i.test(lastHtml || '')

  return { results: results.slice(0, count), blocked }
}

async function runBingSearch(page: any, params: SearchParams) {
  const count = Math.min(Math.max(params.count ?? 10, 1), 20)
  const locale = params.search_lang && params.country ? `${params.search_lang}-${params.country}` : params.search_lang || 'en-US'
  const query = encodeURIComponent(params.q)
  const searchUrl = `https://www.bing.com/search?q=${query}&count=${count}&setlang=${encodeURIComponent(locale)}`

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
  await page.waitForSelector('li.b_algo h2 a', { timeout: 10_000 }).catch(() => {})
  const html = await page.content().catch(() => '')
  if (html) dumpHtml(html, 'bing')

  const results = await page.evaluate(() => {
    const items: { title: string; url: string; description: string; position: number }[] = []
    document.querySelectorAll<HTMLLIElement>('li.b_algo').forEach((el, idx) => {
      const link = el.querySelector<HTMLAnchorElement>('h2 a')
      const title = link?.textContent?.trim()
      const href = link?.getAttribute('href')?.trim()
      const desc = el.querySelector<HTMLParagraphElement>('p')?.textContent?.trim() || ''
      if (title && href && href.startsWith('http')) {
        items.push({ title, url: href, description: desc, position: idx + 1 })
      }
    })
    return items
  })

  return results.slice(0, count)
}

// Dispatch a search by:
// 1) creating a Browser.cash session
// 2) waiting for CDP to be ready
// 3) connecting via CDP and fetching a Google SERP (falls back to Bing on block)
// 4) cleaning up the session
export async function dispatchBrowserQuery(params: SearchParams) {
  const session = await createSession()
  const sessionId = session.sessionId
  let browser: any | null = null

  try {
    const activeSession = await waitForActiveSession(sessionId)
    if (!activeSession.cdpUrl) throw new Error('No CDP URL returned for session')

    browser = await chromium.connectOverCDP(activeSession.cdpUrl)
    const context = browser.contexts()[0] || (await browser.newContext())
    const page = context.pages()[0] || (await context.newPage())

    // Prefer Bing (more stable) and fall back to Google if empty
    let results = await runBingSearch(page, params)
    if (!results || !results.length) {
      const g = await runGoogleSearch(page, params)
      if (g.results?.length) results = g.results
    }
    await browser.close().catch(() => {})
    browser = null
    return { results }
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
    await stopSession(sessionId)
  }
}
