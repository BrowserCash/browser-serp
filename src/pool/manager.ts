import { BrowserCashApiClient } from '../browsercash-api.js'
import type { CDPClient } from '../cdp.js'
import { invalidateWsUrlCache } from '../cdp-resolve.js'
import { IS_PERSISTENT_RUNTIME, parsePoolConfig } from './config.js'
import { hardResetSession } from './reset.js'
import { ScopedCDPClient } from './scoped-cdp.js'
import type {
  BrowserNode,
  PageSlot,
  PageSlotLease,
  PageSlotRef,
  PoolRuntimeConfig,
  QueueWaiter,
  ScrapeAttemptOutcome,
  WarmCDPContext,
} from './types.js'
import { resetPageSlot } from './warm-reset.js'
import { teardownBrowserNode, teardownWarmContext, warmUpBrowser } from './warmup.js'

const POOL_DEBUG = process.env.SERP_POOL_DEBUG === '1' || process.env.SERP_POOL_DEBUG === 'true'

function poolLog(...args: unknown[]): void {
  if (!POOL_DEBUG) return
  console.log(...args)
}

export class BrowserPoolManager {
  private readonly api: BrowserCashApiClient
  private readonly nodes = new Map<string, BrowserNode>()
  private readonly waitQueue: QueueWaiter[] = []
  private readonly resetTimeoutMs: number
  private readonly healthCheckTimeoutMs: number
  private readonly createSessionTimeoutMs: number
  private readonly sessionReadyTimeoutMs: number
  private readonly emergencyCreateTimeoutMs: number
  private readonly emergencyReadyTimeoutMs: number
  private readonly effectiveQueueTimeoutMs: number
  private readonly qualityFailRetireThreshold = 3

  private uniqueNodesSaturated = false
  private warmPromise: Promise<void> | null = null
  private maintenancePromise: Promise<void> | null = null
  private emergencyLeaseInFlight = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private leaseCounter = 0
  private targetCursor = 0
  private lastValidationMs = 0
  private lastMaintenanceEndMs = 0
  private maintenanceCooldownMs = 15_000
  private maintenanceDeferredTimer: ReturnType<typeof setTimeout> | null = null
  private createFailureStreak = 0
  private shuttingDown = false
  private readonly targetBySlotId: Map<string, PoolRuntimeConfig['expandedTargets'][number]>

  constructor(private readonly config: PoolRuntimeConfig) {
    poolLog(`[pool] persistWarmConnections=${config.persistWarmConnections} IS_PERSISTENT_RUNTIME=${IS_PERSISTENT_RUNTIME} pagesPerBrowser=${config.pagesPerBrowser} raceWidth=${config.raceWidth}`)
    this.api = new BrowserCashApiClient(config.apiKey)
    this.targetBySlotId = new Map(config.expandedTargets.map((target) => [target.slotId, target]))
    this.resetTimeoutMs = Math.max(5_000, Math.min(Math.floor(config.attemptTimeoutMs), 8_000))
    this.healthCheckTimeoutMs = Math.max(8_000, Math.min(config.heartbeatMs, 15_000))
    this.createSessionTimeoutMs = Math.max(20_000, Math.min(config.queueTimeoutMs, 45_000))
    this.sessionReadyTimeoutMs = Math.max(15_000, Math.min(config.queueTimeoutMs, 30_000))
    this.emergencyCreateTimeoutMs = Math.max(20_000, Math.min(this.createSessionTimeoutMs, 35_000))
    this.emergencyReadyTimeoutMs = Math.max(10_000, Math.min(this.sessionReadyTimeoutMs, 20_000))
    this.effectiveQueueTimeoutMs = config.queueTimeoutMs
    this.startHeartbeat()
    void this.ensureWarmPool().catch(() => {})
    void this.scheduleMaintenance()
  }

  get attemptTimeoutMs(): number {
    return this.config.attemptTimeoutMs
  }

  get minHtmlLength(): number {
    return this.config.minHtmlLength
  }

  async init(): Promise<void> {
    await this.ensureWarmPool()
    await this.awaitAvailableSlots(Math.max(1, this.config.raceWidth), Math.min(this.effectiveQueueTimeoutMs, 45_000))
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.maintenanceDeferredTimer) {
      clearTimeout(this.maintenanceDeferredTimer)
      this.maintenanceDeferredTimer = null
    }

    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()
      if (!waiter) continue
      clearTimeout(waiter.timeoutId)
      waiter.reject(new Error('Browser pool shutting down'))
    }

    await Promise.allSettled([this.warmPromise, this.maintenancePromise].filter(Boolean))

    const nodes = [...this.nodes.values()]
    await Promise.allSettled(nodes.map((node) => this.retireNode(node)))
    this.nodes.clear()
  }

  getPoolStats(): { total: number; totalNodes: number; totalSlots: number; available: number; inUse: number } {
    let totalSlots = 0
    let available = 0
    for (const node of this.nodes.values()) {
      for (const slot of node.slots) {
        totalSlots++
        if (!slot.inUse) available++
      }
    }
    return {
      total: totalSlots, // backward compat
      totalNodes: this.nodes.size,
      totalSlots,
      available,
      inUse: totalSlots - available,
    }
  }

  // ── Lease acquisition ─────────────────────────────────────────────

  async acquireLease(): Promise<PageSlotLease> {
    if (this.shuttingDown) {
      throw new Error('Browser pool is shutting down')
    }

    const t0 = Date.now()
    const stats = this.getPoolStats()
    poolLog(`[pool] acquireLease: nodes=${stats.totalNodes} slots=${stats.totalSlots} available=${stats.available} queue=${this.waitQueue.length}`)
    this.reapStaleInUseSlots()

    if (this.nodes.size === 0 && this.createFailureStreak >= 2) {
      const created = await Promise.race([
        this.tryCreateEmergencyNode(),
        this.sleep(2_000).then(() => false),
      ]).catch(() => false)
      if (!created) {
        throw new Error('Browser pool unavailable')
      }
      const recovered = this.tryAcquireImmediate()
      if (recovered) {
        poolLog(`[pool] acquireLease: emergency recovered in ${Date.now() - t0}ms`)
        void this.scheduleMaintenance()
        return recovered
      }
    }

    const immediate = this.tryAcquireImmediate()
    if (immediate) {
      poolLog(`[pool] acquireLease: immediate in ${Date.now() - t0}ms`)
      if (stats.available <= this.config.raceWidth || this.nodes.size < this.config.desiredPoolSize) {
        void this.scheduleMaintenance()
      }
      return immediate
    }

    poolLog(`[pool] acquireLease: no slots available, waiting...`)
    void this.ensureWarmPool().catch(() => {})
    void this.scheduleMaintenance()
    const lease = await this.waitForLease(this.effectiveQueueTimeoutMs)
    poolLog(`[pool] acquireLease: waited ${Date.now() - t0}ms`)
    return lease
  }

  /**
   * Acquire a single slot from the pool without the full racing pipeline.
   * Used by the search pipeline for parallel page scrapes.
   */
  acquireSingleSlot(): PageSlotLease | null {
    return this.acquireSingleImmediate()
  }

  async acquireFreshLease(url: string, attemptIndex: number): Promise<PageSlotLease | null> {
    const target = this.pickRecoveryTarget(url, attemptIndex)
    const created = await this.tryCreateEmergencyNodeForTarget(target).catch(() => false)
    if (!created) return null
    return this.acquireSingleImmediate(target.slotId)
  }

  // ── Release ───────────────────────────────────────────────────────

  async releaseSlot(
    sessionId: string,
    slotIndex: number,
    outcome: ScrapeAttemptOutcome | undefined,
    sourceUrl: string,
  ): Promise<void> {
    const node = this.nodes.get(sessionId)
    if (!node) return
    const slot = node.slots[slotIndex]
    if (!slot) return
    await this.releaseOneSlot(node, slot, outcome, sourceUrl)
  }

  async releaseLease(lease: PageSlotLease, outcomes: ScrapeAttemptOutcome[], sourceUrl: string): Promise<void> {
    const outcomeByKey = new Map(outcomes.map((o) => [o.sessionId, o]))

    void Promise.allSettled(
      lease.slots.map((ref) => {
        const node = this.nodes.get(ref.browserNodeSessionId)
        if (!node) return Promise.resolve()
        const slot = node.slots[ref.slotIndex]
        if (!slot) return Promise.resolve()
        // Use composite key for outcome lookup
        const outcomeKey = `${ref.browserNodeSessionId}:${ref.slotIndex}`
        return this.releaseOneSlot(node, slot, outcomeByKey.get(outcomeKey) ?? outcomeByKey.get(ref.browserNodeSessionId), sourceUrl)
      }),
    ).then(() => {
      this.tryServeQueue()
    })
  }

  // ── Internal release logic ────────────────────────────────────────

  private async releaseOneSlot(
    node: BrowserNode,
    slot: PageSlot,
    outcome: ScrapeAttemptOutcome | undefined,
    sourceUrl: string,
  ): Promise<void> {
    if (!slot.inUse && !slot.inUseSinceMs) {
      return
    }

    if (this.shuttingDown) {
      slot.inUse = false
      slot.inUseSinceMs = null
      teardownWarmContext(slot.warm)
      slot.warm = null
      return
    }

    if (outcome?.error === 'aborted_by_race_winner') {
      // Hedged slot was reserved but never used; skip expensive reset.
      slot.inUse = false
      slot.inUseSinceMs = null
      this.tryServeQueue()
      return
    }

    let shouldRetireSlot = false
    let shouldRetireNode = false

    if (outcome) {
      if (outcome.success && outcome.qualityPass) {
        slot.consecutiveQualityFails = 0
      } else if (outcome.success && !outcome.qualityPass) {
        slot.consecutiveQualityFails += 1
      }
    }

    if (slot.useCount >= this.config.sessionMaxUses) {
      shouldRetireSlot = true
    }

    if (Date.now() - node.createdAtMs >= this.config.sessionMaxAgeMs) {
      shouldRetireNode = true
    }

    if (slot.consecutiveQualityFails >= this.qualityFailRetireThreshold) {
      shouldRetireSlot = true
    }

    if (shouldRetireNode) {
      await this.retireNode(node)
      this.tryServeQueue()
      return
    }

    if (shouldRetireSlot) {
      await this.recycleSlot(node, slot)
      this.tryServeQueue()
      return
    }

    const origins = new Set<string>([sourceUrl])
    if (outcome?.finalUrl) {
      origins.add(outcome.finalUrl)
    }
    const originList = [...origins]

    if (this.config.persistWarmConnections) {
      if (slot.warm && !slot.warm.client.closed) {
        // Warm reset via scoped client — domain-specific cleanup
        void (async () => {
          try {
            await this.withTimeout(
              resetPageSlot({ client: slot.warm!.client, origins: originList }),
              this.resetTimeoutMs,
              `Warm reset timed out for ${node.sessionId.slice(0, 8)}:${slot.slotIndex}`,
            )
            poolLog(`[pool] release ${node.sessionId.slice(0, 8)}:${slot.slotIndex}: warm reset OK`)
            slot.inUse = false
            slot.inUseSinceMs = null
            this.tryServeQueue()
          } catch (err) {
            poolLog(`[pool] release ${node.sessionId.slice(0, 8)}:${slot.slotIndex}: warm reset failed, recycling: ${err instanceof Error ? err.message : String(err)}`)
            teardownWarmContext(slot.warm)
            slot.warm = null
            slot.inUse = false
            slot.inUseSinceMs = null
            this.tryServeQueue()
            void this.rewarmSlot(node, slot)
          }
        })()
      } else {
        // No warm context — hard reset + re-warm
        teardownWarmContext(slot.warm)
        slot.warm = null
        slot.inUse = false
        slot.inUseSinceMs = null
        this.tryServeQueue()

        void (async () => {
          try {
            await this.withTimeout(
              hardResetSession({ cdpUrl: node.cdpUrl, origins: originList }),
              this.resetTimeoutMs,
              `Session reset timed out for ${node.sessionId}`,
            )
          } catch {
            // Non-fatal
          }
          poolLog(`[pool] release ${node.sessionId.slice(0, 8)}:${slot.slotIndex}: cold release, re-warming`)
          void this.rewarmSlot(node, slot)
        })()
      }
    } else {
      // Non-persistent (CF Workers): teardown warm, mark available
      teardownWarmContext(slot.warm)
      slot.warm = null
      slot.inUse = false
      slot.inUseSinceMs = null
      this.tryServeQueue()

      void (async () => {
        try {
          await this.withTimeout(
            hardResetSession({ cdpUrl: node.cdpUrl, origins: originList }),
            this.resetTimeoutMs,
            `Session reset timed out for ${node.sessionId}`,
          )
        } catch {}
      })()
    }
  }

  // ── Slot recycling (close page target, create fresh one) ──────────

  private async recycleSlot(node: BrowserNode, slot: PageSlot): Promise<void> {
    teardownWarmContext(slot.warm)
    slot.warm = null
    slot.inUse = false
    slot.inUseSinceMs = null

    if (!node.client || node.client.closed) return

    // Close old page target
    if (slot.pageTargetId) {
      try {
        await node.client.send('Target.closeTarget', { targetId: slot.pageTargetId })
      } catch {}
    }

    // Create fresh page target
    let scopedClient: ScopedCDPClient | null = null
    try {
      const createResult = await node.client.send('Target.createTarget', { url: 'about:blank' })
      const pageTargetId = createResult.targetId as string
      const attachResult = await node.client.send('Target.attachToTarget', {
        targetId: pageTargetId,
        flatten: true,
      })
      const cdpSessionId = attachResult.sessionId as string
      scopedClient = new ScopedCDPClient(node.client, cdpSessionId)

      await Promise.all([
        scopedClient.send('Page.enable'),
        scopedClient.send('Network.enable'),
        scopedClient.send('Runtime.enable'),
      ])

      slot.pageTargetId = pageTargetId
      slot.cdpSessionId = cdpSessionId
      slot.useCount = 0
      slot.consecutiveQualityFails = 0
      slot.warm = {
        client: scopedClient,
        resolvedWsUrl: node.resolvedWsUrl!,
        cdpSessionId,
        pageTargetId,
        domainsEnabled: true,
      }
      poolLog(`[pool] recycled slot ${node.sessionId.slice(0, 8)}:${slot.slotIndex}`)
    } catch (err) {
      // Clean up leaked ScopedCDPClient if it was created before the error
      if (scopedClient) scopedClient.close()
      poolLog(`[pool] recycleSlot failed for ${node.sessionId.slice(0, 8)}:${slot.slotIndex}: ${err instanceof Error ? err.message : String(err)}`)
      slot.pageTargetId = null
      slot.cdpSessionId = null
    }
  }

  // ── Re-warm a single slot ─────────────────────────────────────────

  private async rewarmSlot(node: BrowserNode, slot: PageSlot): Promise<void> {
    if (!this.config.persistWarmConnections) return
    if (!node.client || node.client.closed) return
    if (!slot.pageTargetId) return

    let scopedClient: ScopedCDPClient | null = null
    try {
      const attachResult = await node.client.send('Target.attachToTarget', {
        targetId: slot.pageTargetId,
        flatten: true,
      })
      const cdpSessionId = attachResult.sessionId as string
      scopedClient = new ScopedCDPClient(node.client, cdpSessionId)

      await Promise.all([
        scopedClient.send('Page.enable'),
        scopedClient.send('Network.enable'),
        scopedClient.send('Runtime.enable'),
      ])

      slot.cdpSessionId = cdpSessionId
      slot.warm = {
        client: scopedClient,
        resolvedWsUrl: node.resolvedWsUrl!,
        cdpSessionId,
        pageTargetId: slot.pageTargetId,
        domainsEnabled: true,
      }
      poolLog(`[pool] re-warmed slot ${node.sessionId.slice(0, 8)}:${slot.slotIndex}`)
    } catch (err) {
      // Clean up leaked ScopedCDPClient if it was created before the error
      if (scopedClient) scopedClient.close()
      poolLog(`[pool] re-warm failed for ${node.sessionId.slice(0, 8)}:${slot.slotIndex}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Queue management ──────────────────────────────────────────────

  private waitForLease(maxWaitMs = this.effectiveQueueTimeoutMs): Promise<PageSlotLease> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Browser pool is shutting down'))
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const pulseId = setInterval(() => {
        if (settled) return
        if (this.shuttingDown) {
          settleReject(new Error('Browser pool is shutting down'))
          return
        }
        this.reapStaleInUseSlots()
        const immediate = this.tryAcquireImmediate()
        if (immediate) {
          settleResolve(immediate)
          return
        }
        this.queueEmergencyLeaseForQueue()
      }, 400)

      const settleResolve = (lease: PageSlotLease) => {
        if (settled) return
        settled = true
        this.removeWaiterByTimeout(timeoutId)
        clearInterval(pulseId)
        clearTimeout(timeoutId)
        resolve(lease)
      }
      const settleReject = (error: Error) => {
        if (settled) return
        settled = true
        this.removeWaiterByTimeout(timeoutId)
        clearInterval(pulseId)
        clearTimeout(timeoutId)
        reject(error)
      }

      const timeoutId = setTimeout(() => {
        void (async () => {
          if (this.shuttingDown) {
            settleReject(new Error('Browser pool is shutting down'))
            return
          }

          this.reapStaleInUseSlots()
          const immediate = this.tryAcquireImmediate()
          if (immediate) {
            settleResolve(immediate)
            return
          }

          const created = await this.tryCreateEmergencyNode().catch(() => false)
          if (created) {
            const recovered = this.tryAcquireImmediate()
            if (recovered) {
              settleResolve(recovered)
              return
            }
          }
          settleReject(new Error('Browser pool queue timeout'))
        })()
      }, maxWaitMs)

      this.waitQueue.push({
        resolve: settleResolve,
        reject: settleReject,
        timeoutId,
      })

      this.reapStaleInUseSlots()
      this.tryServeQueue()
      this.queueEmergencyLeaseForQueue()
      void this.scheduleMaintenance()
    })
  }

  private removeWaiterByTimeout(timeoutId: ReturnType<typeof setTimeout>): void {
    const idx = this.waitQueue.findIndex((waiter) => waiter.timeoutId === timeoutId)
    if (idx !== -1) {
      this.waitQueue.splice(idx, 1)
    }
  }

  private tryServeQueue(): void {
    if (this.shuttingDown) return
    if (this.waitQueue.length === 0) return

    const lease = this.tryAcquireImmediate()
    if (!lease) return

    const waiter = this.waitQueue.shift()
    if (!waiter) return

    clearTimeout(waiter.timeoutId)
    waiter.resolve(lease)
  }

  // ── Slot acquisition ──────────────────────────────────────────────

  private tryAcquireImmediate(): PageSlotLease | null {
    if (this.shuttingDown) return null

    const available = this.getAvailableSlots()
    if (available.length === 0) return null

    const width =
      this.waitQueue.length > 0
        ? 1
        : Math.min(available.length, this.config.raceWidth)

    // Prefer slots from different BrowserNodes for fault diversity
    const selected = this.selectDiverseSlots(available, width)
    const now = Date.now()

    const refs: PageSlotRef[] = []
    for (const { node, slot } of selected) {
      slot.inUse = true
      slot.inUseSinceMs = now
      slot.useCount += 1
      refs.push({
        browserNodeSessionId: node.sessionId,
        slotIndex: slot.slotIndex,
        sessionId: `${node.sessionId}:${slot.slotIndex}`,
        cdpUrl: node.cdpUrl,
        warm: slot.warm,
      })
    }

    return {
      leaseId: `lease-${now}-${++this.leaseCounter}`,
      acquiredAtMs: now,
      slots: refs,
    }
  }

  private acquireSingleImmediate(preferredSlotId?: string): PageSlotLease | null {
    if (this.shuttingDown) return null

    const available = this.getAvailableSlots()
    if (available.length === 0) return null

    let pick = available[0]
    if (preferredSlotId) {
      const preferred = available.find(({ node }) => node.targetSlotId === preferredSlotId)
      if (preferred) pick = preferred
    }

    const { node, slot } = pick
    const now = Date.now()
    slot.inUse = true
    slot.inUseSinceMs = now
    slot.useCount += 1

    return {
      leaseId: `lease-${now}-${++this.leaseCounter}`,
      acquiredAtMs: now,
      slots: [{
        browserNodeSessionId: node.sessionId,
        slotIndex: slot.slotIndex,
        sessionId: `${node.sessionId}:${slot.slotIndex}`,
        cdpUrl: node.cdpUrl,
        warm: slot.warm,
      }],
    }
  }

  private getAvailableSlots(): Array<{ node: BrowserNode; slot: PageSlot }> {
    const results: Array<{ node: BrowserNode; slot: PageSlot }> = []
    for (const node of this.nodes.values()) {
      for (const slot of node.slots) {
        if (!slot.inUse && slot.pageTargetId) {
          results.push({ node, slot })
        }
      }
    }
    // Sort by node priority, then by slot index
    results.sort((a, b) => {
      const rankDelta = this.nodePriority(a.node) - this.nodePriority(b.node)
      if (rankDelta !== 0) return rankDelta
      const nodeDelta = a.node.servedBy.localeCompare(b.node.servedBy)
      if (nodeDelta !== 0) return nodeDelta
      return a.slot.slotIndex - b.slot.slotIndex
    })
    if (results.length <= 1) return results

    const rotate = this.leaseCounter % results.length
    if (rotate === 0) return results
    return results.slice(rotate).concat(results.slice(0, rotate))
  }

  private selectDiverseSlots(
    available: Array<{ node: BrowserNode; slot: PageSlot }>,
    width: number,
  ): Array<{ node: BrowserNode; slot: PageSlot }> {
    const selected: Array<{ node: BrowserNode; slot: PageSlot }> = []
    const usedNodes = new Set<string>()

    // First pass: pick one slot per unique node
    for (const entry of available) {
      if (selected.length >= width) break
      if (usedNodes.has(entry.node.sessionId)) continue
      selected.push(entry)
      usedNodes.add(entry.node.sessionId)
    }

    // Second pass: fill remaining from any node
    if (selected.length < width) {
      for (const entry of available) {
        if (selected.length >= width) break
        if (selected.includes(entry)) continue
        selected.push(entry)
      }
    }

    return selected
  }

  private nodePriority(node: BrowserNode): number {
    const target = this.targetBySlotId.get(node.targetSlotId)
    const type = target?.payload.type
    const country = target?.payload.country

    if (type === 'hosted' && country === 'US') return 0
    if (type === 'hosted') return 1
    if (type === 'consumer_distributed') return 2
    return 3
  }

  // ── Pool warmup & maintenance ─────────────────────────────────────

  private async ensureWarmPool(): Promise<void> {
    if (this.shuttingDown) return

    let rounds = 0
    while (!this.shuttingDown && this.nodes.size < this.config.desiredPoolSize && rounds < 5) {
      if (this.warmPromise) {
        await this.warmPromise
      } else {
        this.warmPromise = this.replenish(this.config.desiredPoolSize).finally(() => {
          this.warmPromise = null
        })
        await this.warmPromise
      }
      rounds += 1
    }
  }

  private async awaitAvailableSlots(minAvailable: number, timeoutMs: number): Promise<void> {
    const started = Date.now()

    while (!this.shuttingDown && Date.now() - started < timeoutMs) {
      if (this.getAvailableSlots().length >= minAvailable) {
        return
      }
      await this.sleep(250)
    }

    if (this.getAvailableSlots().length === 0) {
      throw new Error('Browser pool warm-up did not produce available slots in time')
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return

    this.heartbeatTimer = setInterval(() => {
      void this.scheduleMaintenance()
    }, this.config.heartbeatMs)

    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      const timer = this.heartbeatTimer as ReturnType<typeof setInterval> & { unref?: () => void }
      timer.unref?.()
    }
  }

  private async scheduleMaintenance(): Promise<void> {
    if (this.shuttingDown) return

    if (this.maintenancePromise) {
      return this.maintenancePromise
    }

    const sinceLastEnd = Date.now() - this.lastMaintenanceEndMs
    if (this.lastMaintenanceEndMs > 0 && sinceLastEnd < this.maintenanceCooldownMs) {
      if (!this.maintenanceDeferredTimer) {
        this.maintenanceDeferredTimer = setTimeout(() => {
          this.maintenanceDeferredTimer = null
          void this.scheduleMaintenance()
        }, this.maintenanceCooldownMs - sinceLastEnd)
      }
      return
    }

    this.maintenancePromise = (async () => {
      const urgentTargetSize = this.config.desiredPoolSize
      const now = Date.now()
      if (now - this.lastValidationMs >= this.config.heartbeatMs) {
        this.lastValidationMs = now
        await this.validateNodes()
      }
      await this.replenish(urgentTargetSize)
    })()
      .catch(() => {})
      .finally(() => {
        if (this.shuttingDown) {
          this.maintenancePromise = null
          return
        }

        this.maintenancePromise = null
        this.lastMaintenanceEndMs = Date.now()
        this.tryServeQueue()

        if (this.nodes.size < this.config.desiredPoolSize || this.waitQueue.length > 0) {
          if (!this.maintenanceDeferredTimer) {
            this.maintenanceDeferredTimer = setTimeout(() => {
              this.maintenanceDeferredTimer = null
              void this.scheduleMaintenance()
            }, this.maintenanceCooldownMs)
          }
        }
      })

    return this.maintenancePromise
  }

  // ── Validation ────────────────────────────────────────────────────

  private async validateNodes(): Promise<void> {
    const candidates = [...this.nodes.values()]

    await Promise.allSettled(
      candidates.map(async (node) => {
        // Check if WebSocket is dead
        if (node.client?.closed) {
          poolLog(`[pool] health: ${node.sessionId.slice(0, 8)} WebSocket closed, retiring`)
          await this.retireNode(node)
          return
        }

        // Check all slots are idle for API-level health check
        const anyInUse = node.slots.some((s) => s.inUse)
        if (anyInUse) return

        let healthy: boolean
        let isTransientFailure = false
        try {
          healthy = await this.refreshNodeHealth(node, this.healthCheckTimeoutMs)
        } catch {
          healthy = false
          isTransientFailure = true
        }
        if (!healthy) {
          if (isTransientFailure) {
            node.consecutiveHealthFails = (node.consecutiveHealthFails ?? 0) + 1
            if (node.consecutiveHealthFails >= 3) {
              await this.retireNode(node)
            }
          } else {
            await this.retireNode(node)
          }
        } else {
          node.consecutiveHealthFails = 0
        }
      }),
    )
  }

  private async refreshNodeHealth(node: BrowserNode, timeoutMs: number): Promise<boolean> {
    const remote = await this.withTimeout(
      this.api.getSession(node.sessionId),
      timeoutMs,
      `Session heartbeat timed out for ${node.sessionId}`,
    )
    if (remote.status === 'completed' || remote.status === 'error') {
      const ageMs = Date.now() - node.createdAtMs
      poolLog(`[pool] health: ${node.sessionId.slice(0, 8)} status=${remote.status} age=${Math.round(ageMs / 1000)}s`)
      return false
    }

    node.lastHeartbeatMs = Date.now()
    if (remote.cdpUrl && remote.cdpUrl !== node.cdpUrl) {
      // CDP URL changed — tear down all warm contexts, update, re-warm
      for (const slot of node.slots) {
        teardownWarmContext(slot.warm)
        slot.warm = null
      }
      if (node.client) {
        try { node.client.close() } catch {}
        node.client = null
      }
      invalidateWsUrlCache(node.cdpUrl)
      node.cdpUrl = remote.cdpUrl
      void this.warmUpNodeSlots(node)
    }

    return true
  }

  // ── Replenish ─────────────────────────────────────────────────────

  private async replenish(minPoolSize = this.config.desiredPoolSize): Promise<void> {
    if (this.shuttingDown) return

    const needed = minPoolSize - this.nodes.size
    if (needed <= 0) return

    const batchSize = Math.min(needed * 2, needed + 4)
    const targets = Array.from({ length: batchSize }, () => this.nextTarget())

    await Promise.allSettled(
      targets.map(async (target) => {
        if (this.shuttingDown) return

        let remoteSession: Awaited<ReturnType<BrowserCashApiClient['createSession']>> | null = null

        try {
          remoteSession = await this.withTimeout(
            this.api.createSession(target.payload),
            this.createSessionTimeoutMs,
            'Session create timed out',
          )
        } catch {
          return
        }

        if (this.shuttingDown) {
          if (remoteSession?.sessionId) void this.safeStop(remoteSession.sessionId)
          return
        }

        remoteSession = await this.awaitSessionReady(remoteSession)
        if (this.shuttingDown) {
          if (remoteSession?.sessionId) void this.safeStop(remoteSession.sessionId)
          return
        }
        if (!remoteSession?.cdpUrl) {
          if (remoteSession?.sessionId) {
            void this.safeStop(remoteSession.sessionId)
          }
          return
        }

        const nodeSessionCount = this.nodeCountByServedBy(remoteSession.servedBy)
        if (nodeSessionCount > 0) {
          if (!this.uniqueNodesSaturated || nodeSessionCount >= 3) {
            void this.safeStop(remoteSession.sessionId)
            return
          }
        }

        if (this.nodes.size >= minPoolSize) {
          void this.safeStop(remoteSession.sessionId)
          return
        }

        if (this.shuttingDown) {
          void this.safeStop(remoteSession.sessionId)
          return
        }

        const now = Date.now()
        const node: BrowserNode = {
          sessionId: remoteSession.sessionId,
          cdpUrl: remoteSession.cdpUrl,
          servedBy: remoteSession.servedBy,
          createdAtMs: now,
          targetSlotId: target.slotId,
          lastHeartbeatMs: now,
          consecutiveHealthFails: 0,
          client: null,
          resolvedWsUrl: null,
          slots: [],
        }

        // Initialize empty slot objects
        for (let i = 0; i < this.config.pagesPerBrowser; i++) {
          node.slots.push({
            slotIndex: i,
            browserNodeSessionId: remoteSession.sessionId,
            pageTargetId: null,
            cdpSessionId: null,
            useCount: 0,
            consecutiveQualityFails: 0,
            inUse: false,
            inUseSinceMs: null,
            warm: null,
          })
        }

        this.nodes.set(remoteSession.sessionId, node)
        if (this.nodes.size > minPoolSize) {
          this.nodes.delete(remoteSession.sessionId)
          void this.safeStop(remoteSession.sessionId)
          return
        }
        this.createFailureStreak = 0
        poolLog(`[pool] node ready: ${remoteSession.sessionId.slice(0, 8)} served_by=${remoteSession.servedBy} pool=${this.nodes.size} slots=${node.slots.length}`)

        // Warm up all page slots in the background
        void this.warmUpNodeSlots(node)

        this.tryServeQueue()
      }),
    )

    if (this.nodes.size < minPoolSize && !this.uniqueNodesSaturated) {
      this.uniqueNodesSaturated = true
      poolLog(`[pool] unique nodes saturated at ${this.uniqueNodeCount()} nodes, ${this.nodes.size}/${minPoolSize} sessions — allowing duplicates`)
    }
  }

  /**
   * Warm up all page slots for a node by connecting the parent WebSocket
   * and creating page targets.
   */
  private async warmUpNodeSlots(node: BrowserNode): Promise<void> {
    if (this.shuttingDown) return

    if (!this.config.persistWarmConnections) return

    try {
      const result = await warmUpBrowser(node.cdpUrl, this.config.pagesPerBrowser)
      if (this.shuttingDown) {
        teardownBrowserNode(result.client, result.slots)
        void this.safeStop(node.sessionId)
        return
      }
      if (!this.nodes.has(node.sessionId)) {
        // Node was retired while warming
        teardownBrowserNode(result.client, result.slots)
        return
      }

      node.client = result.client
      node.resolvedWsUrl = result.resolvedWsUrl

      for (const warmSlot of result.slots) {
        const slot = node.slots[warmSlot.slotIndex]
        if (!slot) continue
        slot.pageTargetId = warmSlot.pageTargetId
        slot.cdpSessionId = warmSlot.cdpSessionId
        slot.warm = warmSlot.warm
      }

      poolLog(`[pool] warm-up OK: ${node.sessionId.slice(0, 8)} ${result.slots.length} slots`)
      this.tryServeQueue()
    } catch (err) {
      poolLog(`[pool] warm-up FAILED: ${node.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Emergency node creation ───────────────────────────────────────

  private async tryCreateEmergencyNode(): Promise<boolean> {
    const target = this.pickEmergencyTarget()
    return this.tryCreateEmergencyNodeForTarget(target)
  }

  private async tryCreateEmergencyNodeForTarget(
    target: PoolRuntimeConfig['expandedTargets'][number],
  ): Promise<boolean> {
    if (this.shuttingDown) return false

    let remoteSession: Awaited<ReturnType<BrowserCashApiClient['createSession']>> | null = null
    try {
      remoteSession = await this.withTimeout(
        this.api.createSession(target.payload),
        this.emergencyCreateTimeoutMs,
        'Emergency session create timed out',
      )
    } catch {
      this.createFailureStreak += 1
      return false
    }

    if (this.shuttingDown) {
      if (remoteSession?.sessionId) void this.safeStop(remoteSession.sessionId)
      return false
    }

    remoteSession = await this.awaitSessionReady(remoteSession, this.emergencyReadyTimeoutMs)
    if (this.shuttingDown) {
      if (remoteSession?.sessionId) void this.safeStop(remoteSession.sessionId)
      return false
    }
    if (!remoteSession?.cdpUrl) {
      if (remoteSession?.sessionId) {
        void this.safeStop(remoteSession.sessionId)
      }
      this.createFailureStreak += 1
      return false
    }

    const now = Date.now()
    const node: BrowserNode = {
      sessionId: remoteSession.sessionId,
      cdpUrl: remoteSession.cdpUrl,
      servedBy: remoteSession.servedBy,
      createdAtMs: now,
      targetSlotId: target.slotId,
      lastHeartbeatMs: now,
      consecutiveHealthFails: 0,
      client: null,
      resolvedWsUrl: null,
      slots: [],
    }

    for (let i = 0; i < this.config.pagesPerBrowser; i++) {
      node.slots.push({
        slotIndex: i,
        browserNodeSessionId: remoteSession.sessionId,
        pageTargetId: null,
        cdpSessionId: null,
        useCount: 0,
        consecutiveQualityFails: 0,
        inUse: false,
        inUseSinceMs: null,
        warm: null,
      })
    }

    this.nodes.set(remoteSession.sessionId, node)
    if (this.nodes.size > this.config.desiredPoolSize + this.config.raceWidth) {
      this.nodes.delete(remoteSession.sessionId)
      void this.safeStop(remoteSession.sessionId)
      return false
    }
    this.createFailureStreak = 0
    void this.warmUpNodeSlots(node)

    return true
  }

  private queueEmergencyLeaseForQueue(): void {
    if (this.shuttingDown) return

    if (this.waitQueue.length === 0) return
    if (this.emergencyLeaseInFlight) return

    this.emergencyLeaseInFlight = true
    void this.tryCreateEmergencyNode()
      .catch(() => {})
      .finally(() => {
        this.emergencyLeaseInFlight = false
        this.tryServeQueue()
      })
  }

  // ── Node retirement ───────────────────────────────────────────────

  private async retireNode(node: BrowserNode): Promise<void> {
    // Close all scoped clients
    for (const slot of node.slots) {
      teardownWarmContext(slot.warm)
      slot.warm = null
    }
    // Close parent WebSocket
    if (node.client) {
      try { node.client.close() } catch {}
      node.client = null
    }
    this.nodes.delete(node.sessionId)
    void this.safeStop(node.sessionId)
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private nodeCountByServedBy(servedBy: string): number {
    let count = 0
    for (const node of this.nodes.values()) {
      if (node.servedBy === servedBy) count++
    }
    return count
  }

  private uniqueNodeCount(): number {
    const servers = new Set<string>()
    for (const node of this.nodes.values()) {
      servers.add(node.servedBy)
    }
    return servers.size
  }

  private nextTarget() {
    const target = this.config.expandedTargets[this.targetCursor % this.config.expandedTargets.length]
    this.targetCursor += 1
    return target
  }

  private pickEmergencyTarget() {
    const preferredUsHosted = this.config.expandedTargets.find(
      (target) => target.payload.type === 'hosted' && target.payload.country === 'US',
    )
    if (preferredUsHosted) return preferredUsHosted

    const preferredHosted = this.config.expandedTargets.find((target) => target.payload.type === 'hosted')
    if (preferredHosted) return preferredHosted

    return this.config.expandedTargets[0]
  }

  private pickRecoveryTarget(_url: string, attemptIndex: number): PoolRuntimeConfig['expandedTargets'][number] {
    const hosted = this.config.expandedTargets.filter((target) => target.payload.type === 'hosted')
    const distributed = this.config.expandedTargets.filter((target) => target.payload.type === 'consumer_distributed')
    const fallback = this.config.expandedTargets

    const ordered = [...hosted, ...distributed, ...fallback]

    const deduped: PoolRuntimeConfig['expandedTargets'] = []
    const seen = new Set<string>()
    for (const target of ordered) {
      if (seen.has(target.slotId)) continue
      seen.add(target.slotId)
      deduped.push(target)
    }

    if (deduped.length === 0) {
      return this.config.expandedTargets[0]
    }

    return deduped[attemptIndex % deduped.length]
  }

  private async safeStop(sessionId: string): Promise<void> {
    try {
      await this.api.stopSession(sessionId)
    } catch {}
  }

  private async awaitSessionReady<T extends { sessionId: string; cdpUrl: string | null }>(
    session: T,
    timeoutMs = this.sessionReadyTimeoutMs,
  ): Promise<T | null> {
    if (session.cdpUrl) {
      return session
    }

    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      await this.sleep(500)
      let latest: Awaited<ReturnType<BrowserCashApiClient['getSession']>>
      try {
        latest = await this.withTimeout(
          this.api.getSession(session.sessionId),
          Math.min(this.healthCheckTimeoutMs, 4_000),
          `Session readiness timed out for ${session.sessionId}`,
        )
      } catch {
        continue
      }

      if (latest.cdpUrl && (latest.status === 'active' || latest.status === 'starting')) {
        return latest as unknown as T
      }

      if (latest.status === 'completed' || latest.status === 'error') {
        return null
      }
    }

    return null
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      promise
        .then((value) => {
          clearTimeout(timer)
          resolve(value)
        })
        .catch((error) => {
          clearTimeout(timer)
          reject(error)
        })
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private reapStaleInUseSlots(): void {
    const now = Date.now()
    let touched = false

    for (const node of this.nodes.values()) {
      for (const slot of node.slots) {
        if (!slot.inUse || !slot.inUseSinceMs) continue
        if (now - slot.inUseSinceMs < Math.max(this.config.attemptTimeoutMs * 2 + 10_000, 45_000)) continue

        slot.inUse = false
        slot.inUseSinceMs = null
        touched = true
      }
    }

    if (touched) {
      this.tryServeQueue()
    }
  }
}

let singleton: BrowserPoolManager | null = null
let singletonKey = ''

export function getBrowserPoolManager(env: Record<string, unknown>): BrowserPoolManager {
  const mergedEnv: Record<string, unknown> = { ...process.env, ...env }
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value === '' || value === undefined) delete mergedEnv[key]
  }
  const config = parsePoolConfig(mergedEnv)

  const key = JSON.stringify({
    apiKey: config.apiKey,
    targets: config.expandedTargets.map((target) => ({ slotId: target.slotId, payload: target.payload })),
    queueTimeoutMs: config.queueTimeoutMs,
    heartbeatMs: config.heartbeatMs,
    sessionMaxUses: config.sessionMaxUses,
    sessionMaxAgeMs: config.sessionMaxAgeMs,
    sessionDurationSec: config.sessionDurationSec,
    windowSize: config.windowSize,
    defaultType: config.defaultType,
    attemptTimeoutMs: config.attemptTimeoutMs,
    minHtmlLength: config.minHtmlLength,
    pagesPerBrowser: config.pagesPerBrowser,
    raceWidth: config.raceWidth,
  })

  if (!singleton || singletonKey !== key) {
    singleton = new BrowserPoolManager(config)
    singletonKey = key
  }

  return singleton
}
