import type { BrowserCashCreateSessionPayload, BrowserCashSessionType } from '../browsercash-api.js'
import type { ExpandedPoolTarget, PoolRuntimeConfig, PoolTargetConfig } from './types.js'

export const IS_PERSISTENT_RUNTIME: boolean =
  typeof process !== 'undefined' &&
  !!process.versions?.node &&
  !('caches' in globalThis)  // CF Workers has caches; Node.js does not

const VALID_TYPES = new Set<BrowserCashSessionType>(['consumer_distributed', 'hosted', 'testing'])

interface PoolEnv {
  BROWSER_CASH_API_KEY?: unknown
  BROWSER_API_KEY?: unknown
  BROWSER_POOL_TARGETS_JSON?: unknown
  SERP_POOL_SIZE?: unknown
  BROWSER_POOL_QUEUE_TIMEOUT_MS?: unknown
  BROWSER_POOL_HEARTBEAT_MS?: unknown
  BROWSER_POOL_SESSION_MAX_USES?: unknown
  BROWSER_POOL_SESSION_MAX_AGE_MS?: unknown
  BROWSER_POOL_SESSION_DURATION_SEC?: unknown
  BROWSER_POOL_WINDOW_SIZE?: unknown
  BROWSER_POOL_TYPE_DEFAULT?: unknown
  BROWSER_POOL_ATTEMPT_TIMEOUT_MS?: unknown
  BROWSER_POOL_MIN_HTML_LENGTH?: unknown
  BROWSER_POOL_MAX_DUPLICATE_NODE_RETRIES?: unknown
  BROWSER_POOL_PAGES_PER_BROWSER?: unknown
  BROWSER_POOL_RACE_WIDTH?: unknown
}

export function parsePoolConfig(env: Record<string, unknown>): PoolRuntimeConfig {
  const source = env as PoolEnv

  const apiKey = asString(source.BROWSER_CASH_API_KEY) ?? asString(source.BROWSER_API_KEY)
  if (!apiKey) {
    throw new Error('BROWSER_CASH_API_KEY (or BROWSER_API_KEY) is required when using pooled scraping')
  }

  const defaultType = parseSessionType(source.BROWSER_POOL_TYPE_DEFAULT, 'BROWSER_POOL_TYPE_DEFAULT') ?? 'consumer_distributed'
  const queueTimeoutMsRaw = parsePositiveInt(
    source.BROWSER_POOL_QUEUE_TIMEOUT_MS,
    'BROWSER_POOL_QUEUE_TIMEOUT_MS',
    60_000,
  )
  const queueTimeoutMs = Math.max(60_000, queueTimeoutMsRaw)
  const heartbeatMs = parsePositiveInt(source.BROWSER_POOL_HEARTBEAT_MS, 'BROWSER_POOL_HEARTBEAT_MS', 20_000)
  const sessionMaxUses = parsePositiveInt(source.BROWSER_POOL_SESSION_MAX_USES, 'BROWSER_POOL_SESSION_MAX_USES', 25)
  const sessionMaxAgeMs = parsePositiveInt(source.BROWSER_POOL_SESSION_MAX_AGE_MS, 'BROWSER_POOL_SESSION_MAX_AGE_MS', 600_000)
  const sessionDurationSec = parseInRangeInt(source.BROWSER_POOL_SESSION_DURATION_SEC, 'BROWSER_POOL_SESSION_DURATION_SEC', 600, 61, 3600)
  const windowSize = asString(source.BROWSER_POOL_WINDOW_SIZE) ?? '1920x1080'
  const attemptTimeoutMs = parsePositiveInt(source.BROWSER_POOL_ATTEMPT_TIMEOUT_MS, 'BROWSER_POOL_ATTEMPT_TIMEOUT_MS', 15_000)
  const minHtmlLength = parsePositiveInt(source.BROWSER_POOL_MIN_HTML_LENGTH, 'BROWSER_POOL_MIN_HTML_LENGTH', 256)
  const maxDuplicateNodeRetries = parsePositiveInt(
    source.BROWSER_POOL_MAX_DUPLICATE_NODE_RETRIES,
    'BROWSER_POOL_MAX_DUPLICATE_NODE_RETRIES',
    4,
  )
  const pagesPerBrowser = parseInRangeInt(source.BROWSER_POOL_PAGES_PER_BROWSER, 'BROWSER_POOL_PAGES_PER_BROWSER', 4, 1, 16)
  const raceWidth = parseInRangeInt(source.BROWSER_POOL_RACE_WIDTH, 'BROWSER_POOL_RACE_WIDTH', 3, 1, 8)
  const legacyPoolSize = parseInRangeInt(source.SERP_POOL_SIZE, 'SERP_POOL_SIZE', 3, 1, 100)
  const fallbackTargetsJson = JSON.stringify([{ country: 'US', type: 'hosted', count: legacyPoolSize }])

  const targets = parseTargets(source.BROWSER_POOL_TARGETS_JSON ?? fallbackTargetsJson, defaultType, windowSize, sessionDurationSec)
  const expandedTargets = expandTargets(targets, windowSize, sessionDurationSec, defaultType)

  if (expandedTargets.length === 0) {
    throw new Error('BROWSER_POOL_TARGETS_JSON must define at least one target with count >= 1')
  }

  return {
    apiKey,
    queueTimeoutMs,
    heartbeatMs,
    sessionMaxUses,
    sessionMaxAgeMs,
    sessionDurationSec,
    windowSize,
    defaultType,
    attemptTimeoutMs,
    minHtmlLength,
    maxDuplicateNodeRetries,
    persistWarmConnections: IS_PERSISTENT_RUNTIME,
    targets,
    expandedTargets,
    desiredPoolSize: expandedTargets.length,
    pagesPerBrowser,
    raceWidth,
  }
}

function parseTargets(
  raw: unknown,
  defaultType: BrowserCashSessionType,
  defaultWindowSize: string,
  defaultDuration: number,
): PoolTargetConfig[] {
  const json = asString(raw)
  if (!json) {
    throw new Error('BROWSER_POOL_TARGETS_JSON is required when using pooled scraping')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`BROWSER_POOL_TARGETS_JSON must be valid JSON: ${(error as Error).message}`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error('BROWSER_POOL_TARGETS_JSON must be an array')
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`BROWSER_POOL_TARGETS_JSON[${index}] must be an object`)
    }

    const target = entry as Record<string, unknown>
    const count = parsePositiveInt(target.count, `BROWSER_POOL_TARGETS_JSON[${index}].count`, 0)
    if (count <= 0) {
      throw new Error(`BROWSER_POOL_TARGETS_JSON[${index}].count must be >= 1`)
    }

    const nodeId = asString(target.nodeId)
    const country = asString(target.country)
    const proxyUrl = asString(target.proxyUrl)
    const type = parseSessionType(target.type, `BROWSER_POOL_TARGETS_JSON[${index}].type`) ?? defaultType
    const windowSize = asString(target.windowSize) ?? defaultWindowSize
    const duration = parseInRangeInt(
      target.duration,
      `BROWSER_POOL_TARGETS_JSON[${index}].duration`,
      defaultDuration,
      61,
      3600,
    )

    if (!nodeId && !country && !proxyUrl) {
      throw new Error(
        `BROWSER_POOL_TARGETS_JSON[${index}] must provide at least one of nodeId/country/proxyUrl`,
      )
    }

    if (nodeId && proxyUrl) {
      throw new Error(`BROWSER_POOL_TARGETS_JSON[${index}] cannot combine nodeId with proxyUrl`)
    }

    return {
      count,
      nodeId,
      country,
      proxyUrl,
      type: proxyUrl ? 'hosted' : type,
      windowSize,
      duration,
    }
  })
}

function expandTargets(
  targets: PoolTargetConfig[],
  defaultWindowSize: string,
  defaultDuration: number,
  defaultType: BrowserCashSessionType,
): ExpandedPoolTarget[] {
  const expanded: ExpandedPoolTarget[] = []

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]

    for (let slot = 0; slot < target.count; slot++) {
      const payload: BrowserCashCreateSessionPayload = {
        windowSize: target.windowSize ?? defaultWindowSize,
        duration: target.duration ?? defaultDuration,
      }

      if (target.nodeId) {
        payload.nodeId = target.nodeId
      } else {
        if (target.country) payload.country = target.country
        payload.type = target.proxyUrl ? 'hosted' : target.type ?? defaultType
      }

      if (target.proxyUrl) {
        payload.proxyUrl = target.proxyUrl
        payload.type = 'hosted'
      }

      expanded.push({
        slotId: `target-${i}-slot-${slot}`,
        payload,
      })
    }
  }

  return expanded
}

function parseSessionType(raw: unknown, key: string): BrowserCashSessionType | undefined {
  const value = asString(raw)
  if (!value) return undefined

  if (!VALID_TYPES.has(value as BrowserCashSessionType)) {
    throw new Error(`${key} must be one of consumer_distributed|hosted|testing`)
  }

  return value as BrowserCashSessionType
}

function parsePositiveInt(raw: unknown, key: string, fallback: number): number {
  const n = asInt(raw, fallback)
  if (n === null) return fallback
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${key} must be a non-negative integer`)
  }

  return n
}

function parseInRangeInt(raw: unknown, key: string, fallback: number, min: number, max: number): number {
  const n = asInt(raw, fallback)
  if (n === null) return fallback
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`)
  }

  return n
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asInt(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isInteger(value) ? value : fallback
  if (typeof value === 'string' && value.trim().length > 0) return Number.parseInt(value, 10)
  return fallback
}
