import { loadEnvNumber } from '../env.js';
import { SessionPool } from './pool.js';
import { runGoogleSearch } from './search.js';
import type { SearchParams, SearchResult } from './types.js';

const DEBUG_LOG = process.env.SERP_DEBUG_LOG === '1' || process.env.SERP_DEBUG_LOG === 'true';

// Configuration
const POOL_SIZE = loadEnvNumber('SERP_POOL_SIZE', 3);
const SEARCH_TIMEOUT_MS = loadEnvNumber('SERP_SEARCH_TIMEOUT_MS', 30_000);
const MAX_RETRIES = loadEnvNumber('SERP_MAX_RETRIES', 2);

export type { SearchParams, SearchResult };

export interface SerpClient {
  init(): Promise<void>;
  search(params: SearchParams): Promise<{ results: SearchResult[] }>;
  shutdown(): Promise<void>;
  stats(): ReturnType<SessionPool['stats']>;
}

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * Race an operation against browser/page disconnect events
 */
function withDisconnectGuards<T>(page: unknown, browser: unknown, op: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const pageAny = page as any;
    const browserAny = browser as any;

    const cleanup = () => {
      try {
        browserAny?.off?.('disconnected', onDisconnect);
        pageAny?.off?.('close', onClose);
        pageAny?.off?.('crash', onCrash);
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

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onDisconnect = () => finishErr(new Error('browser_disconnected'));
    const onClose = () => finishErr(new Error('page_closed'));
    const onCrash = () => finishErr(new Error('page_crashed'));

    try {
      browserAny?.on?.('disconnected', onDisconnect);
      pageAny?.on?.('close', onClose);
      pageAny?.on?.('crash', onCrash);
    } catch {
      // Ignore listener attachment errors
    }

    op.then(finishOk).catch(finishErr);
  });
}

/**
 * Check if an error is retriable
 */
function isRetriableError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  const retriablePatterns = [
    'TargetClosedError',
    'TimeoutError',
    'browser_disconnected',
    'page_closed',
    'page_crashed',
    'Target page, context or browser has been closed',
    'Target closed',
    'Session closed',
    'Protocol error',
    'Connection closed',
    'net::ERR_',
    'Timeout',
    'timeout',
    'timed out',
  ];

  return retriablePatterns.some((p) => name.includes(p) || message.includes(p));
}

/**
 * Check if error indicates a disconnect
 */
function isDisconnectError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);

  const disconnectPatterns = [
    'browser_disconnected',
    'page_closed',
    'page_crashed',
    'Target page, context or browser has been closed',
    'Target closed',
    'Session closed',
    'Protocol error',
    'Connection closed',
  ];

  return disconnectPatterns.some((p) => msg.includes(p));
}

/**
 * Pooled SERP client with automatic retry and session management
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
        const { results, blocked } = await withTimeout(
          withDisconnectGuards(session.page, session.browser, runGoogleSearch(session.page, params)),
          SEARCH_TIMEOUT_MS,
          `Search operation timed out after ${SEARCH_TIMEOUT_MS}ms`
        );

        if (DEBUG_LOG) {
          console.log('[serp] search completed', {
            results: results.length,
            ms: Date.now() - startTime,
          });
        }

        if (results.length > 0) {
          this.pool.release(session, false);
          return { results };
        }

        // Empty results - retry if blocked
        lastResults = results;

        if (attempt < MAX_RETRIES) {
          if (DEBUG_LOG) {
            console.log('[serp] empty results, retrying', {
              attempt: attempt + 1,
              blocked,
              ms: Date.now() - startTime,
            });
          }
          this.pool.release(session, blocked);
          continue;
        }

        if (DEBUG_LOG) {
          console.log('[serp] max retries reached', { blocked, ms: Date.now() - startTime });
        }
        this.pool.release(session, blocked);
        return { results: lastResults };
      } catch (err) {
        lastError = err;
        const isTimeout = err instanceof Error && /timeout|timed out/i.test(err.message);

        if (DEBUG_LOG) {
          console.log('[serp] search error', {
            attempt: attempt + 1,
            ms: Date.now() - startTime,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (isRetriableError(err) && attempt < MAX_RETRIES) {
          if (DEBUG_LOG) {
            console.log('[serp] retrying with new session', { attempt: attempt + 1 });
          }
          this.pool.release(session, isDisconnectError(err) || isTimeout);
          continue;
        }

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
export function createSerpClient(options: { poolSize?: number } = {}): SerpClient {
  const poolSize = options.poolSize ?? POOL_SIZE;

  if (DEBUG_LOG) {
    console.log('[serp] creating pooled client', { poolSize });
  }

  return new PooledSerpClient(poolSize);
}
