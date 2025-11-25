import { chromium } from 'patchright-core'
import { request } from 'undici'
import { loadEnvString } from '../lib/env.js'
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'

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
    // Capture HTML and offload parsing to OpenRouter to be resilient to DOM tweaks
    const html = await page.content().catch(() => '')
    if (html) dumpHtml(html, 'google-parsed')

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      // Fallback to DOM parsing if no key
      return await page.evaluate(() => {
        const items: { title: string; url: string; description: string; position: number }[] = []
        const candidates = Array.from(document.querySelectorAll<HTMLDivElement>('div.g, div.tF2Cxc, div.MjjYud'))
        const extractDesc = (root: Element | null) => {
          if (!root) return ''
          const descNode =
            root.querySelector<HTMLElement>('div.VwiC3b') ||
            root.querySelector<HTMLElement>('span.aCOpRe') ||
            root.querySelector<HTMLElement>('div.PV9nzc') ||
            root.querySelector<HTMLElement>('div.AP7Wnd') ||
            root.querySelector<HTMLElement>('div[data-sncf]') ||
            root.querySelector<HTMLElement>('span[data-sncf]')
          return descNode?.textContent?.trim() || ''
        }
        candidates.forEach((el) => {
          const link = el.querySelector<HTMLAnchorElement>('a')
          const titleEl = el.querySelector<HTMLHeadingElement>('h3')
          const href = link?.href?.trim()
          const title = titleEl?.textContent?.trim()
          if (!title || !href || !href.startsWith('http')) return
          const desc = extractDesc(el)
          items.push({ title, url: href, description: desc, position: items.length + 1 })
        })
        return items
      })
    }

    try {
      const prompt = `
You are a DOM parser. Extract up to ${params.count} web search results from the HTML of a Google SERP.
For each result, return: title, url, description, position (starting at 1).
Ignore non-result cards (people also ask, images, videos).
Return a JSON array.`

      const resp = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You extract structured search results from HTML.' },
            { role: 'user', content: `${prompt}\n\nHTML:\n${html.slice(0, 18000)}` },
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
      // Strip markdown fences if present
      text = text.trim()
      if (text.startsWith('```')) {
        const firstFence = text.indexOf('```')
        const secondFence = text.indexOf('```', firstFence + 3)
        if (secondFence > firstFence) {
          text = text.slice(firstFence + 3, secondFence).trim()
          if (text.startsWith('json')) {
            text = text.slice(4).trim()
          }
        }
      }
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (r) => r && typeof r.title === 'string' && typeof r.url === 'string' && r.url.startsWith('http')
          )
          .map((r, idx) => ({
            title: String(r.title).trim(),
            url: String(r.url).trim(),
            description: String(r.description || '').trim(),
            position: Number(r.position) > 0 ? Number(r.position) : idx + 1,
          }))
      }
    } catch (err) {
      console.error('[serp-parser] openrouter failed, falling back to DOM parse', err?.message || err)
    }

    // Fallback to DOM parse on errors
    return await page.evaluate(() => {
      const items: { title: string; url: string; description: string; position: number }[] = []
      const candidates = Array.from(document.querySelectorAll<HTMLDivElement>('div.g, div.tF2Cxc, div.MjjYud'))

      function extractDesc(root: Element | null): string {
        if (!root) return ''
        const descNode =
          root.querySelector<HTMLElement>('div.VwiC3b') ||
          root.querySelector<HTMLElement>('span.aCOpRe') ||
          root.querySelector<HTMLElement>('div.PV9nzc') ||
          root.querySelector<HTMLElement>('div.AP7Wnd') ||
          root.querySelector<HTMLElement>('div[data-sncf]') ||
          root.querySelector<HTMLElement>('span[data-sncf]')
        return descNode?.textContent?.trim() || ''
      }

      for (const el of candidates) {
        const link = el.querySelector<HTMLAnchorElement>('a')
        const titleEl = el.querySelector<HTMLHeadingElement>('h3')
        const href = link?.href?.trim()
        const title = titleEl?.textContent?.trim()
        if (!title || !href || !href.startsWith('http')) continue
        const desc = extractDesc(el)
        items.push({ title, url: href, description: desc, position: items.length + 1 })
      }
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
  const session = await createSession()
  const sessionId = session.sessionId
  let browser: any | null = null

  try {
    const activeSession = await waitForActiveSession(sessionId)
    if (!activeSession.cdpUrl) throw new Error('No CDP URL returned for session')

    browser = await chromium.connectOverCDP(activeSession.cdpUrl)
    const context = browser.contexts()[0] || (await browser.newContext())
    const page = context.pages()[0] || (await context.newPage())

    const g = await runGoogleSearch(page, params)
    const results = g.results
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
