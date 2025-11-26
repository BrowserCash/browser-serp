import { loadEnvNumber } from "../env.js";
import { SessionPool, createConnectedSession, closeConnectedSession } from "./pool.js";
import { runGoogleSearch } from "./search.js";
import { SearchParams, SearchResult } from "./types.js";

const DEBUG_LOG = process.env.SERP_DEBUG_LOG === "1" || process.env.SERP_DEBUG_LOG === "true";

// Pool configuration
const POOL_SIZE = loadEnvNumber("SERP_POOL_SIZE", 3);

// Search timeout - max time for entire search operation (default: 30 seconds)
const SEARCH_TIMEOUT_MS = loadEnvNumber("SERP_SEARCH_TIMEOUT_MS", 30_000);
const MAX_RETRIES = loadEnvNumber("SERP_MAX_RETRIES", 2);

export type { SearchParams, SearchResult };

export interface SerpClient {
  init(): Promise<void>;
  search(params: SearchParams): Promise<{ results: SearchResult[] }>;
  shutdown(): Promise<void>;
}

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
