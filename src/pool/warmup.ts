import { CDPClient } from '../cdp.js'
import { resolveWsUrl } from '../cdp-resolve.js'
import { ScopedCDPClient } from './scoped-cdp.js'
import type { WarmCDPContext } from './types.js'

const WARMUP_CONNECT_TIMEOUT_MS = 10_000

export interface WarmPageSlot {
  slotIndex: number
  pageTargetId: string
  cdpSessionId: string
  scopedClient: ScopedCDPClient
  warm: WarmCDPContext
}

export interface WarmBrowserResult {
  client: CDPClient
  resolvedWsUrl: string
  slots: WarmPageSlot[]
}

/**
 * Warm up a browser with N page slots (tabs in the default context).
 * Returns the parent CDPClient + an array of WarmPageSlot per page.
 */
export async function warmUpBrowser(cdpUrl: string, pageCount: number): Promise<WarmBrowserResult> {
  const resolvedWsUrl = await resolveWsUrl(cdpUrl)
  const client = await CDPClient.connect(resolvedWsUrl, WARMUP_CONNECT_TIMEOUT_MS)

  try {
    // Find existing page targets
    const targetsResult = await client.send('Target.getTargets')
    const targets = targetsResult.targetInfos as Array<{ targetId: string; type: string; url: string }>
    const existingPages = targets.filter((t) => t.type === 'page')

    const slots: WarmPageSlot[] = []

    // Reuse the first existing page (some providers require at least one alive)
    const firstPage = existingPages[0]
    if (firstPage) {
      const slot = await attachAndEnableSlot(client, resolvedWsUrl, firstPage.targetId, 0)
      slots.push(slot)

      // Navigate existing page to about:blank to ensure clean state
      await slot.scopedClient.send('Page.navigate', { url: 'about:blank' }).catch(() => {})
    }

    // Create additional pages up to pageCount
    const toCreate = pageCount - slots.length
    for (let i = 0; i < toCreate; i++) {
      const createResult = await client.send('Target.createTarget', { url: 'about:blank' })
      const pageTargetId = createResult.targetId as string
      const slot = await attachAndEnableSlot(client, resolvedWsUrl, pageTargetId, slots.length)
      slots.push(slot)
    }

    // Close extra existing pages beyond what we need
    for (let i = 1; i < existingPages.length; i++) {
      // Only close pages we didn't reuse
      const alreadyUsed = slots.some((s) => s.pageTargetId === existingPages[i].targetId)
      if (!alreadyUsed) {
        await client.send('Target.closeTarget', { targetId: existingPages[i].targetId }).catch(() => {})
      }
    }

    return { client, resolvedWsUrl, slots }
  } catch (err) {
    client.close()
    throw err
  }
}

async function attachAndEnableSlot(
  client: CDPClient,
  resolvedWsUrl: string,
  pageTargetId: string,
  slotIndex: number,
): Promise<WarmPageSlot> {
  const attachResult = await client.send('Target.attachToTarget', {
    targetId: pageTargetId,
    flatten: true,
  })
  const cdpSessionId = attachResult.sessionId as string

  const scopedClient = new ScopedCDPClient(client, cdpSessionId)

  // Enable required domains via scoped client
  await Promise.all([
    scopedClient.send('Page.enable'),
    scopedClient.send('Network.enable'),
    scopedClient.send('Runtime.enable'),
  ])

  const warm: WarmCDPContext = {
    client: scopedClient,
    resolvedWsUrl,
    cdpSessionId,
    pageTargetId,
    domainsEnabled: true,
  }

  return { slotIndex, pageTargetId, cdpSessionId, scopedClient, warm }
}

/**
 * Tear down an entire browser node: close all scoped clients + parent WebSocket.
 */
export function teardownBrowserNode(client: CDPClient | null, slots: WarmPageSlot[]): void {
  for (const slot of slots) {
    try { slot.scopedClient.close() } catch {}
  }
  if (client) {
    try { client.close() } catch {}
  }
}

/**
 * Tear down a single warm context (backward compat for slot-level teardown).
 */
export function teardownWarmContext(warm: WarmCDPContext | null | undefined): void {
  if (!warm) return
  try { warm.client.close() } catch {}
}
