// Standalone SERP scraper for Browser.cash playgrounds.
// Usage: node src/scripts/serp-playground.mjs "query" 5
// Env:
//   CDP_URL | TAURINE_CDP_URL | BROWSER_CASH_CDP_URL | CDP_ENDPOINT (pick one)
//   SEARCH_LANG / SEARCH_COUNTRY (optional)

import { chromium } from 'patchright-core'

const QUERY = process.argv[2] || 'browser cash serp'
const COUNT = Math.min(Math.max(Number(process.argv[3] || 5), 1), 20)
const LANG = process.env.SEARCH_LANG || 'en'
const COUNTRY = process.env.SEARCH_COUNTRY

const DEFAULT_CDP_URL = TAURINE_CDP_URL

async function connect({ cdpUrl = DEFAULT_CDP_URL, contextOptions = {} } = {}) {
  if (!cdpUrl) throw new Error('Provide a CDP URL (CDP_URL/TAURINE_CDP_URL/CDP_ENDPOINT/etc)')

  const browser = await chromium.connectOverCDP(cdpUrl.trim())

  let createdContext = false
  let createdPage = false

  let context = browser.contexts()[0]
  if (!context) {
    context = await browser.newContext(contextOptions)
    createdContext = true
  }

  let page = context.pages()[0]
  if (!page) {
    page = await context.newPage()
    createdPage = true
  }

  const cleanup = async () => {
    try {
      // Never close the remote browser in CDP mode; only close what we created
      if (createdPage) {
        try { await page.close({ runBeforeUnload: false }) } catch {}
      }
      if (createdContext) {
        try { await context.close() } catch {}
      }
    } catch {}
  }

  return { browser, context, page, isCDP: true, cleanup }
}

async function withPage(fn, options) {
  const { browser, context, page, isCDP, cleanup } = await connect(options)
  try {
    return await fn({ browser, context, page, isCDP })
  } finally {
    await cleanup()
  }
}

function buildSearchUrl({ q, count, lang, country }) {
  const hl = lang || 'en'
  const gl = country ? country.toLowerCase() : undefined
  const query = encodeURIComponent(q)
  return `https://www.google.com/search?q=${query}&num=${count}&hl=${encodeURIComponent(hl)}${gl ? `&gl=${encodeURIComponent(gl)}` : ''}&safe=off`
}

async function parseDomResults(page, limit) {
  return page.evaluate((max) => {
    const uniq = new Set()
    const candidates = [
      ...document.querySelectorAll('div#search div.g'),
      ...document.querySelectorAll('div#search div[data-header-feature="0"]'),
      ...document.querySelectorAll('div#rso > div'),
    ]
    candidates.forEach((el) => uniq.add(el))

    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim()
    const list = []

    for (const block of Array.from(uniq)) {
      const link = block.querySelector('a[href]')
      const titleEl = block.querySelector('h3')
      if (!link || !titleEl) continue
      const href = link.getAttribute('href') || ''
      if (!href.startsWith('http')) continue

      const title = clean(titleEl.textContent)
      if (!title) continue

      const descEl =
        block.querySelector('div[data-sncf], div[data-snf], div[data-content-feature], .VwiC3b, div[role="text"], div.MUxGbd') ||
        block.querySelector('span')
      const description = clean(descEl?.innerText || descEl?.textContent || '')

      list.push({ title, url: href, description })
      if (list.length >= max) break
    }

    return list.map((r, idx) => ({ ...r, position: idx + 1 }))
  }, limit)
}

const params = { q: QUERY, count: COUNT, lang: LANG, country: COUNTRY }
const url = buildSearchUrl(params)

await withPage(async ({ page }) => {
  console.log('Navigating to', url)
  await page.context().setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {})
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.waitForSelector('div#search', { timeout: 8_000 }).catch(() => {})

  const results = await parseDomResults(page, params.count)
  console.log(JSON.stringify(results, null, 2))
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
