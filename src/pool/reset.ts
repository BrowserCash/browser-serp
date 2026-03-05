import { CDPClient } from '../cdp.js'
import { resolveWsUrl } from '../cdp-resolve.js'

interface ResetOptions {
  cdpUrl: string
  origins: string[]
}

const RESET_CONNECT_TIMEOUT_MS = 8_000
const RESET_COMMAND_TIMEOUT_MS = 6_000

/**
 * Hard reset — tears down and reconnects via a fresh WebSocket.
 * Used as a node-level fallback when warm per-slot reset fails.
 * Clears cookies for specific domains and storage for specific origins.
 * Does NOT use browser-wide clearBrowserCookies/clearBrowserCache.
 */
export async function hardResetSession(options: ResetOptions): Promise<void> {
  const wsUrl = await resolveWsUrl(options.cdpUrl)
  const client = await CDPClient.connect(wsUrl, RESET_CONNECT_TIMEOUT_MS)

  try {
    await Promise.all([
      clearDomainCookies(client, options.origins),
      clearOriginStorage(client, options.origins),
      resetPageTargets(client),
    ])
  } finally {
    client.close()
  }
}

async function clearDomainCookies(client: CDPClient, rawOrigins: string[]): Promise<void> {
  const origins = [...new Set(rawOrigins.map(normalizeOrigin).filter((x): x is string => Boolean(x)))]
  for (const origin of origins) {
    try {
      const parsed = new URL(origin)
      // Get cookies for this domain and delete them
      const cookiesResult = await sendWithFallback(client, 'Network.getCookies', { urls: [origin] })
      const cookies = cookiesResult.cookies as Array<{ name: string; domain: string; path: string }> | undefined
      if (cookies && cookies.length > 0) {
        await Promise.all(
          cookies.map((cookie) =>
            sendWithFallback(client, 'Network.deleteCookies', {
              name: cookie.name,
              domain: cookie.domain || parsed.hostname,
              path: cookie.path,
            }).catch(() => {}),
          ),
        )
      }
    } catch {
      // non-fatal
    }
  }
}

async function clearOriginStorage(client: CDPClient, rawOrigins: string[]): Promise<void> {
  const origins = [...new Set(rawOrigins.map(normalizeOrigin).filter((x): x is string => Boolean(x)))]
  for (const origin of origins) {
    await sendWithFallback(client, 'Storage.clearDataForOrigin', {
      origin,
      storageTypes: 'all',
    }).catch(() => {})
  }
}

async function resetPageTargets(client: CDPClient): Promise<void> {
  const targetsResult = await sendWithTimeout(client, 'Target.getTargets', {})
  const targetInfos = (targetsResult.targetInfos as Array<{ targetId: string; type: string }>) ?? []
  const pages = targetInfos.filter((target) => target.type === 'page')

  if (pages.length === 0) return

  // Navigate the first page to about:blank to clear state.
  // Close any extras — but always keep at least one page alive so the
  // browser provider doesn't terminate the session.
  const [keep, ...extras] = pages

  const attachResult = await sendWithTimeout(client, 'Target.attachToTarget', {
    targetId: keep.targetId,
    flatten: true,
  })
  const sessionId = attachResult.sessionId as string
  await sendWithTimeout(client, 'Page.navigate', { url: 'about:blank' }, sessionId).catch(() => {})

  if (extras.length > 0) {
    await Promise.all(
      extras.map((target) =>
        sendWithTimeout(client, 'Target.closeTarget', { targetId: target.targetId }).catch(() => {}),
      ),
    )
  }
}

async function sendWithFallback(
  client: CDPClient,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await sendWithTimeout(client, method, params)
  } catch {
    // Some runtimes only support these commands in an attached target session.
    const attach = await attachToAnyPage(client)
    if (!attach?.sessionId) {
      throw new Error(`Failed to execute ${method}`)
    }
    return await sendWithTimeout(client, method, params, attach.sessionId)
  }
}

async function attachToAnyPage(client: CDPClient): Promise<{ sessionId?: string; targetId?: string } | null> {
  const targetsResult = await sendWithTimeout(client, 'Target.getTargets', {})
  const targetInfos = (targetsResult.targetInfos as Array<{ targetId: string; type: string }>) ?? []

  let pageTargetId = targetInfos.find((target) => target.type === 'page')?.targetId
  if (!pageTargetId) {
    const created = await sendWithTimeout(client, 'Target.createTarget', { url: 'about:blank' })
    pageTargetId = created.targetId as string
  }

  const attached = await sendWithTimeout(client, 'Target.attachToTarget', {
    targetId: pageTargetId,
    flatten: true,
  })

  return {
    sessionId: attached.sessionId as string,
    targetId: pageTargetId,
  }
}

function sendWithTimeout(
  client: CDPClient,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.close()
      reject(new Error(`CDP reset command timed out: ${method}`))
    }, RESET_COMMAND_TIMEOUT_MS)

    client
      .send(method, params, sessionId)
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
