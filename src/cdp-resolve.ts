const DISCOVERY_TIMEOUT_MS = 8_000
const wsUrlCache = new Map<string, string>()

export async function resolveWsUrl(cdpUrl: string): Promise<string> {
  if (cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://')) {
    const parsed = new URL(cdpUrl)
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      return cdpUrl
    }
  }

  const cached = wsUrlCache.get(cdpUrl)
  if (cached) return cached

  const httpBase = cdpUrl
    .replace(/^ws:\/\//, 'http://')
    .replace(/^wss:\/\//, 'https://')
    .replace(/\/$/, '')

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${httpBase}/json/version`, { signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`CDP /json/version timed out after ${DISCOVERY_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }

  if (!res.ok) throw new Error(`Failed to get CDP version info: HTTP ${res.status}`)

  const info = (await res.json()) as { webSocketDebuggerUrl?: string }
  if (!info.webSocketDebuggerUrl) {
    throw new Error('CDP /json/version did not contain webSocketDebuggerUrl')
  }
  wsUrlCache.set(cdpUrl, info.webSocketDebuggerUrl)
  return info.webSocketDebuggerUrl
}

export function invalidateWsUrlCache(cdpUrl: string): void {
  wsUrlCache.delete(cdpUrl)
}
