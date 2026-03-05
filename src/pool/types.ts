import type {
  BrowserCashCreateSessionPayload,
  BrowserCashSessionType,
} from '../browsercash-api.js'
import type { CDPClient } from '../cdp.js'

// ---------------------------------------------------------------------------
// CDPClientLike — satisfied by both CDPClient and ScopedCDPClient
// ---------------------------------------------------------------------------

export interface CDPClientLike {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>
  on(method: string, callback: (params: Record<string, unknown>) => void): void
  off(method: string, callback: (params: Record<string, unknown>) => void): void
  close(): void
  readonly closed: boolean
}

// ---------------------------------------------------------------------------
// WarmCDPContext for direct CDP session reuse.
// ---------------------------------------------------------------------------

export interface WarmCDPContext {
  client: CDPClientLike
  resolvedWsUrl: string
  cdpSessionId: string
  pageTargetId: string
  domainsEnabled: boolean
}

// ---------------------------------------------------------------------------
// Pool target configuration
// ---------------------------------------------------------------------------

export interface PoolTargetConfig {
  count: number
  nodeId?: string
  country?: string
  type?: BrowserCashSessionType
  proxyUrl?: string
  windowSize?: string
  duration?: number
}

export interface ExpandedPoolTarget {
  slotId: string
  payload: BrowserCashCreateSessionPayload
}

export interface PoolRuntimeConfig {
  apiKey: string
  queueTimeoutMs: number
  heartbeatMs: number
  sessionMaxUses: number
  sessionMaxAgeMs: number
  sessionDurationSec: number
  windowSize: string
  defaultType: BrowserCashSessionType
  attemptTimeoutMs: number
  minHtmlLength: number
  maxDuplicateNodeRetries: number
  persistWarmConnections: boolean
  targets: PoolTargetConfig[]
  expandedTargets: ExpandedPoolTarget[]
  desiredPoolSize: number
  pagesPerBrowser: number
  raceWidth: number
}

// ---------------------------------------------------------------------------
// BrowserNode — one browser.cash session with N page slots
// ---------------------------------------------------------------------------

export interface BrowserNode {
  sessionId: string
  cdpUrl: string
  servedBy: string
  createdAtMs: number
  targetSlotId: string
  lastHeartbeatMs: number
  consecutiveHealthFails: number
  client: CDPClient | null
  resolvedWsUrl: string | null
  slots: PageSlot[]
}

// ---------------------------------------------------------------------------
// PageSlot — one tab (page target) within a BrowserNode
// ---------------------------------------------------------------------------

export interface PageSlot {
  slotIndex: number
  browserNodeSessionId: string
  pageTargetId: string | null
  cdpSessionId: string | null
  useCount: number
  consecutiveQualityFails: number
  inUse: boolean
  inUseSinceMs: number | null
  warm: WarmCDPContext | null
}

// ---------------------------------------------------------------------------
// Lease types (replaces old PoolLease)
// ---------------------------------------------------------------------------

export interface PageSlotRef {
  browserNodeSessionId: string
  slotIndex: number
  sessionId: string
  cdpUrl: string
  warm: WarmCDPContext | null
}

export interface PageSlotLease {
  leaseId: string
  acquiredAtMs: number
  slots: PageSlotRef[]
}

// ---------------------------------------------------------------------------
// Outcome tracking & queue
// ---------------------------------------------------------------------------

export interface ScrapeAttemptOutcome {
  sessionId: string
  success: boolean
  qualityPass: boolean
  finalUrl?: string
  error?: string
  elapsedMs: number
}

export interface QueueWaiter {
  resolve: (lease: PageSlotLease) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}
