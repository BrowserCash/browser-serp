import type { CDPClientLike } from './types.js'

const WARM_RESET_COMMAND_TIMEOUT_MS = 6_000

interface ResetPageSlotOptions {
  client: CDPClientLike
  origins: string[]
}

/**
 * Per-slot reset: navigates to about:blank, deletes cookies for specific domains,
 * and clears storage for specific origins. Does NOT clear browser-wide state
 * (cookies from other domains, cache) — safe for concurrent multi-tab usage.
 */
export async function resetPageSlot(options: ResetPageSlotOptions): Promise<void> {
  const { client, origins } = options

  if (client.closed) {
    throw new Error('Warm CDP connection is closed')
  }

  // Navigate to about:blank to clear the page
  await sendWithTimeout(client, 'Page.navigate', { url: 'about:blank' })

  // Domain-specific cleanup
  const normalizedOrigins = [...new Set(origins.map(normalizeOrigin).filter((x): x is string => Boolean(x)))]

  await Promise.all([
    // Delete cookies for each scraped domain (NOT browser-wide)
    ...normalizedOrigins.map((origin) =>
      deleteCookiesForDomain(client, origin).catch(() => {
        // non-fatal: some origins may fail
      }),
    ),
    // Clear storage for each origin
    ...normalizedOrigins.map((origin) =>
      sendWithTimeout(client, 'Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'all',
      }).catch(() => {
        // non-fatal: some origins may fail
      }),
    ),
  ])
}

async function deleteCookiesForDomain(client: CDPClientLike, origin: string): Promise<void> {
  try {
    const parsed = new URL(origin)
    const domain = parsed.hostname
    // Network.deleteCookies targets specific domain — won't affect other tabs
    await sendWithTimeout(client, 'Network.deleteCookies', {
      domain,
      name: '*',
    }).catch(async () => {
      // Some CDP versions don't support wildcard name — fall back to
      // getting all cookies for the domain and deleting them individually
      const cookiesResult = await sendWithTimeout(client, 'Network.getCookies', { urls: [origin] })
      const cookies = cookiesResult.cookies as Array<{ name: string; domain: string; path: string }>
      if (cookies && cookies.length > 0) {
        await Promise.all(
          cookies.map((cookie) =>
            sendWithTimeout(client, 'Network.deleteCookies', {
              name: cookie.name,
              domain: cookie.domain,
              path: cookie.path,
            }).catch(() => {}),
          ),
        )
      }
    })
  } catch {
    // non-fatal
  }
}

function sendWithTimeout(
  client: CDPClientLike,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Warm reset command timed out: ${method}`))
    }, WARM_RESET_COMMAND_TIMEOUT_MS)

    client
      .send(method, params)
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function normalizeOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    if (!parsed.protocol.startsWith('http')) return null
    return parsed.origin
  } catch {
    return null
  }
}
