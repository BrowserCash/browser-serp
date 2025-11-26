import { chromium } from "patchright-core";
import BrowsercashSDK from "@browsercash/sdk";
import { loadEnvString, loadEnvNumber } from "../env.js";
import fs from "node:fs";
import path from "node:path";

const BROWSER_API_KEY = loadEnvString("BROWSER_API_KEY");
const DEBUG_HTML =
  process.env.SERP_DEBUG_HTML === "1" || process.env.SERP_DEBUG_HTML === "true";
const DEBUG_LOG =
  process.env.SERP_DEBUG_LOG === "1" || process.env.SERP_DEBUG_LOG === "true";

// Pool configuration
const POOL_SIZE = loadEnvNumber("SERP_POOL_SIZE", 3);
const SESSION_MAX_USES = loadEnvNumber("SERP_SESSION_MAX_USES", 50);
const SESSION_MAX_AGE_MS = loadEnvNumber(
  "SERP_SESSION_MAX_AGE_MS",
  5 * 60 * 1000
);

// Search timeout - max time for entire search operation (default: 30 seconds)
const SEARCH_TIMEOUT_MS = loadEnvNumber("SERP_SEARCH_TIMEOUT_MS", 30_000);

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

// Initialize Browser.cash SDK client
const browserCashClient = new BrowsercashSDK({ apiKey: BROWSER_API_KEY });

export interface SerpClient {
  init(): Promise<void>;
  search(params: SearchParams): Promise<{ results: SearchResult[] }>;
  shutdown(): Promise<void>;
}

export interface SearchParams {
  q: string;
  count: number;
  country?: string;
  search_lang?: string;
  freshness?: "day" | "week" | "month" | "year";
  safesearch?: "off" | "moderate" | "strict";
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  position: number;
}

interface ConnectedSession {
  sessionId: string;
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  page: any;
  createdAt: number;
  useCount: number;
}

function dumpHtml(html: string, label: string): void {
  if (!DEBUG_HTML) return;

  try {
    const outPath = path.join(process.cwd(), `serp-debug-${label}.html`);
    fs.writeFileSync(outPath, html, "utf8");
    console.log(`[serp-debug] wrote ${outPath}`);
  } catch (err) {
    console.error("[serp-debug] failed to write html dump", err);
  }
}

/**
 * DOM extraction script - kept as string to avoid tsx transpilation issues
 */
const DOM_EXTRACTOR_SCRIPT = `
  var uniq = new Set();
  var candidates = [].concat(
    Array.from(document.querySelectorAll('div#search div.g')),
    Array.from(document.querySelectorAll('div#search div[data-header-feature="0"]')),
    Array.from(document.querySelectorAll('div#rso > div'))
  );
  candidates.forEach(function(el) { uniq.add(el); });

  var clean = function(text) { return (text || '').replace(/\\s+/g, ' ').trim(); };
  var list = [];

  var blocks = Array.from(uniq);
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var link = block.querySelector('a[href]');
    var titleEl = block.querySelector('h3');
    if (!link || !titleEl) continue;

    var href = link.getAttribute('href') || '';
    if (href.indexOf('http') !== 0) continue;

    var title = clean(titleEl.textContent);
    if (!title) continue;

    var descEl =
      block.querySelector('div[data-sncf], div[data-snf], div[data-content-feature], .VwiC3b, div[role="text"], div.MUxGbd') ||
      block.querySelector('span');
    var description = clean(descEl ? (descEl.innerText || descEl.textContent || '') : '');

    list.push({ title: title, url: href, description: description });
    if (list.length >= limit) break;
  }

  return list.map(function(r, idx) { return { title: r.title, url: r.url, description: r.description, position: idx + 1 }; });
`;

async function parseDomResults(
  page: any,
  count: number
): Promise<SearchResult[]> {
  const limit = Math.min(Math.max(count, 1), 100);

  const results = await page.evaluate(
    ({ script, limit }: { script: string; limit: number }) => {
      const fn = new Function("limit", script);
      return fn(limit);
    },
    { script: DOM_EXTRACTOR_SCRIPT, limit }
  );

  return results as SearchResult[];
}

async function runGoogleSearch(
  page: any,
  params: SearchParams
): Promise<{ results: SearchResult[]; blocked: boolean }> {
  const count = Math.min(Math.max(params.count ?? 10, 1), 100);
  const requestCount = Math.min(count + 10, 100);
  const hl = params.search_lang || "en";
  const gl = params.country?.toLowerCase();
  const query = encodeURIComponent(params.q);
  const baseUrl = `https://www.google.com/search?q=${query}&num=${requestCount}&hl=${encodeURIComponent(
    hl
  )}${gl ? `&gl=${encodeURIComponent(gl)}` : ""}&safe=off`;

  if (DEBUG_LOG)
    console.log("[serp] searching", { q: params.q, count, requestCount });

  try {
    await page
      .context()
      .setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  } catch {}

  const fetchAndParse = async (
    url: string,
    tag: string
  ): Promise<{ results: SearchResult[]; html: string }> => {
    // Navigate to the page
    const response = await page
      .goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => null);

    // Check if navigation succeeded
    if (!response) {
      if (DEBUG_LOG) console.log("[serp] navigation failed for", tag);
      return { results: [], html: "" };
    }

    // Wait for search results container with multiple selectors
    await page
      .waitForSelector("div#search, div#rso, div#main", { timeout: 8_000 })
      .catch(() => {});

    // Small delay to let dynamic content render
    await new Promise((r) => setTimeout(r, 500));

    const html = await page.content().catch(() => "");
    if (html) dumpHtml(html, tag);

    const results = await parseDomResults(page, requestCount);
    return { results, html };
  };

  // Try base URL first
  let { results, html: lastHtml } = await fetchAndParse(baseUrl, "google-base");

  // If empty, try with basic HTML view (gbv=1)
  if (!results.length) {
    if (DEBUG_LOG) console.log("[serp] trying fallback URL");
    const fallbackUrl = `${baseUrl}&gbv=1`;
    const fallback = await fetchAndParse(fallbackUrl, "google-fallback");
    results = fallback.results;
    lastHtml = fallback.html;
  }

  // If still empty, try one more time with a page refresh
  if (!results.length && lastHtml) {
    if (DEBUG_LOG) console.log("[serp] trying page refresh");
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 10_000 })
      .catch(() => {});
    await page
      .waitForSelector("div#search, div#rso", { timeout: 5_000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    results = await parseDomResults(page, requestCount);
    lastHtml = await page.content().catch(() => "");
  }

  // Detect if we're blocked
  const blocked =
    !results.length &&
    /captcha-form|recaptcha|unusual traffic|consent\.google/i.test(
      lastHtml || ""
    );

  if (DEBUG_LOG)
    console.log("[serp] parsed", { count: results.length, blocked });

  return { results: results.slice(0, count), blocked };
}

/**
 * Create a connected browser session using Browser.cash SDK
 * @see https://docs.browser.cash/docs/browser-api/using-session-api
 */
async function createConnectedSession(): Promise<ConnectedSession> {
  // Use the official SDK to create a session - it handles waiting for CDP URL
  const session = await browserCashClient.browser.session.create();

  if (!session.cdpUrl) {
    throw new Error("No CDP URL returned for session");
  }

  if (DEBUG_LOG)
    console.log("[session] created", { sessionId: session.sessionId });

  const browser = await chromium.connectOverCDP(session.cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  return {
    sessionId: session.sessionId,
    browser,
    page,
    createdAt: Date.now(),
    useCount: 0,
  };
}

/**
 * Close a connected session using Browser.cash SDK
 */
async function closeConnectedSession(
  session: ConnectedSession | null
): Promise<void> {
  if (!session) return;

  try {
    await session.browser.close().catch(() => {});
  } catch {}

  try {
    await browserCashClient.browser.session.stop({
      sessionId: session.sessionId,
    });
    if (DEBUG_LOG)
      console.log("[session] stopped", { sessionId: session.sessionId });
  } catch {
    // Swallow cleanup errors
  }
}

function isSessionUsable(session: ConnectedSession | null): boolean {
  if (!session) return false;
  if (typeof session.page?.isClosed === "function" && session.page.isClosed())
    return false;
  if (session.useCount >= SESSION_MAX_USES) return false;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE_MS) return false;
  return true;
}

// Health check interval for rolling session replacement (default: 30 seconds)
const HEALTH_CHECK_INTERVAL_MS = loadEnvNumber(
  "SERP_HEALTH_CHECK_INTERVAL_MS",
  30_000
);

/**
 * Session Pool - manages multiple concurrent browser sessions with strict limits
 * Features:
 * - Auto-replenishment when sessions fail
 * - Rolling replacement via background health checks (never interrupts in-flight requests)
 * - Wait queue when at capacity
 */
class SessionPool {
  private available: ConnectedSession[] = [];
  private inUse: Set<ConnectedSession> = new Set();
  private creating = 0;
  private closed = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private waitQueue: Array<{
    resolve: (session: ConnectedSession) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(private size: number) {}

  private get totalCount(): number {
    return this.available.length + this.inUse.size + this.creating;
  }

  async init(): Promise<void> {
    if (DEBUG_LOG) console.log("[pool] initializing", { size: this.size });

    // Create initial sessions up to pool size
    const warmupPromises: Promise<void>[] = [];
    for (let i = 0; i < this.size; i++) {
      warmupPromises.push(this.addSession());
    }

    // Wait for at least one session to be ready
    await Promise.race(warmupPromises);

    // Wait for all warmup to complete (don't leave dangling promises)
    await Promise.allSettled(warmupPromises);

    // Start background health check for rolling replacement
    this.startHealthCheck();

    if (DEBUG_LOG) console.log("[pool] initialized", { ...this.stats() });
  }

  /**
   * Background health check - replaces stale sessions without interrupting requests
   * Only checks/replaces sessions in the 'available' pool, never touches 'inUse'
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      if (this.closed) return;
      this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    // Don't prevent process exit
    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  private performHealthCheck(): void {
    if (DEBUG_LOG)
      console.log("[pool] health check starting", { ...this.stats() });

    // Check available sessions for staleness (only available, never inUse)
    const toRemove: ConnectedSession[] = [];

    for (const session of this.available) {
      if (!isSessionUsable(session)) {
        toRemove.push(session);
      }
    }

    // Remove and close stale sessions
    for (const session of toRemove) {
      const idx = this.available.indexOf(session);
      if (idx !== -1) {
        this.available.splice(idx, 1);
        if (DEBUG_LOG)
          console.log("[pool] health check: removing stale session", {
            sessionId: session.sessionId,
            age: Date.now() - session.createdAt,
            useCount: session.useCount,
          });
        closeConnectedSession(session).catch(() => {});
      }
    }

    // Replenish pool if under capacity
    this.replenishPool();

    if (DEBUG_LOG)
      console.log("[pool] health check complete", { ...this.stats() });
  }

  /**
   * Replenish pool to target size (background, non-blocking)
   * Uses atomic increment to prevent race conditions
   */
  private replenishPool(): void {
    // Calculate how many we need, accounting for sessions being created
    const deficit = this.size - this.totalCount;
    if (deficit <= 0) return;

    if (DEBUG_LOG)
      console.log("[pool] replenishing", { deficit, ...this.stats() });

    // Only start ONE addSession call - it will check capacity atomically
    // Subsequent calls will be triggered by release() or health check
    this.addSession().catch(() => {});
  }

  private async addSession(): Promise<void> {
    if (this.closed) return;

    // ATOMIC: Increment FIRST to reserve a slot, preventing race conditions
    this.creating++;

    // Now check if we're over capacity (after incrementing)
    if (this.totalCount > this.size) {
      this.creating--;
      if (DEBUG_LOG)
        console.log("[pool] addSession: already at capacity, aborting", {
          ...this.stats(),
        });
      return;
    }

    try {
      const session = await createConnectedSession();

      if (this.closed) {
        // Pool was shut down while creating
        await closeConnectedSession(session);
        return;
      }

      // Double-check we're not over capacity after async operation
      // (another session might have been added while we were creating)
      if (this.totalCount > this.size) {
        if (DEBUG_LOG)
          console.log(
            "[pool] addSession: over capacity after create, closing",
            {
              sessionId: session.sessionId,
              ...this.stats(),
            }
          );
        await closeConnectedSession(session);
        return;
      }

      // Check if someone is waiting for a session
      if (this.waitQueue.length > 0) {
        const waiter = this.waitQueue.shift()!;
        this.inUse.add(session);
        session.useCount++;
        if (DEBUG_LOG)
          console.log("[pool] session created and assigned to waiter", {
            sessionId: session.sessionId,
            ...this.stats(),
          });
        waiter.resolve(session);
      } else {
        // Add to available pool
        this.available.push(session);
        if (DEBUG_LOG)
          console.log("[pool] session added to pool", {
            sessionId: session.sessionId,
            ...this.stats(),
          });
      }

      // Check if we still need more sessions
      if (this.totalCount < this.size && !this.closed) {
        // Schedule another addSession (not recursive to avoid stack overflow)
        setImmediate(() => this.addSession().catch(() => {}));
      }
    } catch (err) {
      if (DEBUG_LOG) console.error("[pool] failed to create session", err);

      // If someone was waiting and we failed, reject them so they can retry
      if (this.waitQueue.length > 0) {
        const waiter = this.waitQueue.shift()!;
        waiter.reject(err instanceof Error ? err : new Error(String(err)));
      }

      // Schedule replenishment retry after a delay
      if (!this.closed && this.totalCount < this.size) {
        setTimeout(() => this.addSession().catch(() => {}), 5000);
      }
    } finally {
      this.creating--;
    }
  }

  async acquire(): Promise<ConnectedSession> {
    // Try to get an available session
    while (this.available.length > 0) {
      const session = this.available.pop()!;
      if (isSessionUsable(session)) {
        this.inUse.add(session);
        session.useCount++;
        if (DEBUG_LOG)
          console.log("[pool] acquired from pool", {
            sessionId: session.sessionId,
            useCount: session.useCount,
            ...this.stats(),
          });
        return session;
      }
      // Session not usable, close it (replenishment will happen via release or health check)
      if (DEBUG_LOG)
        console.log("[pool] closing unusable session during acquire", {
          sessionId: session.sessionId,
        });
      closeConnectedSession(session).catch(() => {});
    }

    // No available sessions - try to create one with atomic reservation
    // ATOMIC: Increment FIRST to reserve a slot
    this.creating++;

    // Check if we're within capacity (after incrementing)
    if (this.totalCount <= this.size) {
      if (DEBUG_LOG)
        console.log("[pool] no available sessions, creating on-demand", {
          ...this.stats(),
        });

      try {
        const session = await createConnectedSession();

        // Verify we're still within capacity after async creation
        if (this.totalCount > this.size) {
          if (DEBUG_LOG)
            console.log(
              "[pool] over capacity after on-demand create, closing",
              {
                sessionId: session.sessionId,
                ...this.stats(),
              }
            );
          this.creating--;
          await closeConnectedSession(session);
          // Fall through to wait queue
        } else {
          this.creating--;
          this.inUse.add(session);
          session.useCount++;
          if (DEBUG_LOG)
            console.log("[pool] on-demand session created", {
              sessionId: session.sessionId,
              ...this.stats(),
            });
          return session;
        }
      } catch (err) {
        this.creating--;
        throw err;
      }
    } else {
      // Already at capacity, release the reservation
      this.creating--;
    }

    // At capacity - wait for a session to become available
    if (DEBUG_LOG)
      console.log("[pool] at capacity, waiting for session", {
        ...this.stats(),
      });

    return new Promise((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  release(session: ConnectedSession, error?: boolean): void {
    this.inUse.delete(session);

    if (error || !isSessionUsable(session)) {
      if (DEBUG_LOG)
        console.log("[pool] closing released session", {
          sessionId: session.sessionId,
          error,
          useCount: session.useCount,
          ...this.stats(),
        });
      closeConnectedSession(session).catch(() => {});

      // Always replenish after closing a session to maintain pool size
      this.replenishPool();
    } else {
      // Check if someone is waiting
      if (this.waitQueue.length > 0) {
        const waiter = this.waitQueue.shift()!;
        this.inUse.add(session);
        session.useCount++;
        if (DEBUG_LOG)
          console.log("[pool] session reassigned to waiter", {
            sessionId: session.sessionId,
            ...this.stats(),
          });
        waiter.resolve(session);
      } else {
        this.available.push(session);
        if (DEBUG_LOG)
          console.log("[pool] session returned to pool", {
            sessionId: session.sessionId,
            ...this.stats(),
          });
      }
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;

    // Stop health check
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Reject all waiters
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      waiter.reject(new Error("Pool shutting down"));
    }

    const allSessions = [...this.available, ...this.inUse];
    this.available = [];
    this.inUse.clear();

    if (DEBUG_LOG)
      console.log("[pool] shutting down, closing sessions", {
        count: allSessions.length,
      });

    await Promise.all(
      allSessions.map((s) => closeConnectedSession(s).catch(() => {}))
    );

    if (DEBUG_LOG) console.log("[pool] shutdown complete");
  }

  stats() {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      creating: this.creating,
      waiting: this.waitQueue.length,
      total: this.totalCount,
      maxSize: this.size,
    };
  }
}

// Max retries for transient errors (closed sessions, network issues)
const MAX_RETRIES = loadEnvNumber("SERP_MAX_RETRIES", 2);

/**
 * Check if an error is retriable (session closed, network issues, timeouts, etc.)
 */
function isRetriableError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";

  return (
    name === "TargetClosedError" ||
    name === "TimeoutError" ||
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Session closed") ||
    message.includes("Protocol error") ||
    message.includes("Connection closed") ||
    message.includes("net::ERR_") ||
    message.includes("Timeout") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("Search operation timed out")
  );
}

/**
 * Pooled SERP Client - handles concurrent requests with session pooling
 */
class PooledSerpClient implements SerpClient {
  private pool: SessionPool;

  constructor(poolSize: number) {
    this.pool = new SessionPool(poolSize);
  }

  async init(): Promise<void> {
    await this.pool.init();
  }

  async search(params: SearchParams): Promise<{ results: SearchResult[] }> {
    let lastError: unknown;
    let lastResults: SearchResult[] = [];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const session = await this.pool.acquire();
      const startTime = Date.now();

      try {
        // Wrap the entire search operation with a timeout
        const { results, blocked } = await withTimeout(
          runGoogleSearch(session.page, params),
          SEARCH_TIMEOUT_MS,
          `Search operation timed out after ${SEARCH_TIMEOUT_MS}ms`
        );

        if (DEBUG_LOG)
          console.log("[serp] search completed", {
            results: results.length,
            ms: Date.now() - startTime,
          });

        // Check if we got results
        if (results.length > 0) {
          // Success - release session back to pool
          this.pool.release(session, false);
          return { results };
        }

        // Empty results - this is likely a stale session or page load issue
        lastResults = results;

        if (attempt < MAX_RETRIES) {
          if (DEBUG_LOG)
            console.log("[serp] empty results, retrying with new session", {
              attempt: attempt + 1,
              maxRetries: MAX_RETRIES,
              blocked,
              ms: Date.now() - startTime,
            });
          // Release the session as bad (likely stale) and try with a fresh one
          this.pool.release(session, true);
          continue;
        }

        // Max retries reached with empty results - return what we have
        if (DEBUG_LOG)
          console.log("[serp] max retries reached with empty results", {
            blocked,
            ms: Date.now() - startTime,
          });
        this.pool.release(session, true);
        return { results: lastResults };
      } catch (err) {
        lastError = err;

        if (DEBUG_LOG)
          console.log("[serp] search error", {
            attempt: attempt + 1,
            ms: Date.now() - startTime,
            error: err instanceof Error ? err.message : String(err),
          });

        // Check if this is a retriable error (includes timeouts)
        if (isRetriableError(err) && attempt < MAX_RETRIES) {
          if (DEBUG_LOG)
            console.log("[serp] retriable error, retrying with new session", {
              attempt: attempt + 1,
              maxRetries: MAX_RETRIES,
            });
          // Release the bad session (marked as error) and continue to next attempt
          this.pool.release(session, true);
          continue;
        }

        // Non-retriable error or max retries reached - release and throw
        this.pool.release(session, true);
        throw err;
      }
    }

    // Should not reach here, but just in case
    throw lastError;
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }

  stats() {
    return this.pool.stats();
  }
}

/**
 * One-shot client - creates a new session per request (with retry support)
 */
async function dispatchBrowserQuery(
  params: SearchParams
): Promise<{ results: SearchResult[] }> {
  const t0 = Date.now();
  if (DEBUG_LOG)
    console.log("[serp] start", { q: params.q, count: params.count });

  let lastError: unknown;
  let lastResults: SearchResult[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const session = await createConnectedSession();
    const startTime = Date.now();

    try {
      // Wrap with timeout
      const { results, blocked } = await withTimeout(
        runGoogleSearch(session.page, params),
        SEARCH_TIMEOUT_MS,
        `Search operation timed out after ${SEARCH_TIMEOUT_MS}ms`
      );

      if (results.length > 0) {
        if (DEBUG_LOG)
          console.log("[serp] done", {
            results: results.length,
            ms: Date.now() - t0,
          });
        await closeConnectedSession(session);
        return { results };
      }

      // Empty results - retry with fresh session
      lastResults = results;
      await closeConnectedSession(session);

      if (attempt < MAX_RETRIES) {
        if (DEBUG_LOG)
          console.log("[serp] empty results, retrying", {
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            blocked,
            ms: Date.now() - startTime,
          });
        continue;
      }

      // Max retries with empty results
      if (DEBUG_LOG)
        console.log("[serp] max retries reached with empty results", {
          ms: Date.now() - t0,
          blocked,
        });
      return { results: lastResults };
    } catch (err) {
      lastError = err;
      await closeConnectedSession(session);

      if (isRetriableError(err) && attempt < MAX_RETRIES) {
        if (DEBUG_LOG)
          console.log("[serp] retriable error, retrying", {
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
          });
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

/**
 * Create a SERP client
 * @param mode - 'pool' (default) or 'oneshot'
 * @param poolSize - Number of concurrent sessions (for pool mode)
 */
export function createSerpClient(
  options: { mode?: "pool" | "oneshot"; poolSize?: number } = {}
): SerpClient & { stats?: () => any } {
  const mode = options.mode ?? "pool";
  const poolSize = options.poolSize ?? POOL_SIZE;

  if (mode === "pool") {
    if (DEBUG_LOG) console.log("[serp] using pooled client", { poolSize });
    return new PooledSerpClient(poolSize);
  }

  if (DEBUG_LOG) console.log("[serp] using oneshot client");
  return {
    init: async () => {},
    search: dispatchBrowserQuery,
    shutdown: async () => {},
  };
}
