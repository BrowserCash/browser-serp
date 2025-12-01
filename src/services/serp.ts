import { loadEnvNumber } from '../env.js';
import { SessionPool, isSessionUsable } from './pool.js';
import { runGoogleSearch } from './search.js';
import type { SearchParams, SearchResult, ConnectedSession } from './types.js';

const DEBUG_LOG = process.env.SERP_DEBUG_LOG === '1' || process.env.SERP_DEBUG_LOG === 'true';

// Pool configuration
const POOL_SIZE = loadEnvNumber('SERP_POOL_SIZE', 3);

// Search timeout - max time for entire search operation
const SEARCH_TIMEOUT_MS = loadEnvNumber('SERP_SEARCH_TIMEOUT_MS', 30_000);
const MAX_RETRIES = loadEnvNumber('SERP_MAX_RETRIES', 2);

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
 * Race an operation against browser/page disconnect events to fail fast
 */
function withDisconnectGuards<T>(
  page: any,
  browser: any,
  op: Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      try {
        if (browser?.off && onBrowserDisconnected) {
          browser.off('disconnected', onBrowserDisconnected);
        }
      } catch {
        // Ignore cleanup errors
      }
      try {
        if (page?.off) {
          if (onPageClose) page.off('close', onPageClose);
          if (onPageCrash) page.off('crash', onPageCrash);
        }
      } catch {
        // Ignore cleanup errors
      }
    };

    const finishOk = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const finishErr = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onBrowserDisconnected = () => finishErr(new Error('browser_disconnected'));
    const onPageClose = () => finishErr(new Error('page_closed'));
    const onPageCrash = () => finishErr(new Error('page_crashed'));

    try {
      if (typeof browser?.on === 'function') {
        browser.on('disconnected', onBrowserDisconnected);
      }
    } catch {
      // Ignore listener attachment errors
    }

    try {
      if (typeof page?.on === 'function') {
        page.on('close', onPageClose);
        page.on('crash', onPageCrash);
      }
    } catch {
      // Ignore listener attachment errors
    }

    op.then(finishOk).catch(finishErr);
  });
}

/**
 * Check if an error is retriable (session closed, network issues, timeouts, etc.)
 */
function isRetriableError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  return (
    name === 'TargetClosedError' ||
    name === 'TimeoutError' ||
    message.includes('browser_disconnected') ||
    message.includes('page_closed') ||
    message.includes('page_crashed') ||
    message.includes('Target page, context or browser has been closed') ||
    message.includes('Target closed') ||
    message.includes('Session closed') ||
    message.includes('Protocol error') ||
    message.includes('Connection closed') ||
    message.includes('net::ERR_') ||
    message.includes('Timeout') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('Search operation timed out')
  );
}

/**
 * Check if error indicates a disconnect
 */
function isDisconnectError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('browser_disconnected') ||
    msg.includes('page_closed') ||
    msg.includes('page_crashed') ||
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('Target closed') ||
    msg.includes('Session closed') ||
    msg.includes('Protocol error') ||
    msg.includes('Connection closed')
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
        // Wrap the entire search operation with timeout and disconnect guards
        const { results, blocked } = await withTimeout(
          withDisconnectGuards(
            session.page,
            session.browser,
            runGoogleSearch(session.page, params)
          ),
          SEARCH_TIMEOUT_MS,
          `Search operation timed out after ${SEARCH_TIMEOUT_MS}ms`
        );

        if (DEBUG_LOG) {
          console.log('[serp] search completed', {
            results: results.length,
            ms: Date.now() - startTime,
          });
        }

        // Check if we got results
        if (results.length > 0) {
          this.pool.release(session, false);
          return { results };
        }

        // Empty results - retry with fresh session if blocked
        lastResults = results;

        if (attempt < MAX_RETRIES) {
          if (DEBUG_LOG) {
            console.log('[serp] empty results, retrying with new session', {
              attempt: attempt + 1,
              maxRetries: MAX_RETRIES,
              blocked,
              ms: Date.now() - startTime,
            });
          }
          this.pool.release(session, blocked);
          continue;
        }

        // Max retries reached
        if (DEBUG_LOG) {
          console.log('[serp] max retries reached with empty results', {
            blocked,
            ms: Date.now() - startTime,
          });
        }
        this.pool.release(session, blocked);
        return { results: lastResults };
      } catch (err) {
        lastError = err;

        const isTimeout =
          err instanceof Error &&
          (err.message.toLowerCase().includes('timeout') ||
            err.message.toLowerCase().includes('timed out'));

        if (DEBUG_LOG) {
          console.log('[serp] search error', {
            attempt: attempt + 1,
            ms: Date.now() - startTime,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Retry if error is retriable
        if (isRetriableError(err) && attempt < MAX_RETRIES) {
          if (DEBUG_LOG) {
            console.log('[serp] retriable error, retrying with new session', {
              attempt: attempt + 1,
              maxRetries: MAX_RETRIES,
            });
          }
          this.pool.release(session, isDisconnectError(err) || isTimeout);
          continue;
        }

        // Non-retriable or max retries reached
        this.pool.release(session, isDisconnectError(err) || isTimeout);
        throw err;
      }
    }

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
 * Create a SERP client
 */
export function createSerpClient(
  options: { mode?: 'pool'; poolSize?: number } = {}
): SerpClient & { stats?: () => ReturnType<SessionPool['stats']> } {
  const poolSize = options.poolSize ?? POOL_SIZE;

  if (DEBUG_LOG) {
    console.log('[serp] using pooled client', { poolSize });
  }

  return new PooledSerpClient(poolSize);
}
