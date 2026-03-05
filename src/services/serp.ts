import { loadEnvNumber } from '../env.js';
import { SessionPool } from './pool.js';
import { searchWithBrowserPool } from './serp-race.js';
import type { SearchExecutionResult, SearchParams, SearchResult } from './types.js';

const DEBUG_LOG = process.env.SERP_DEBUG_LOG === '1' || process.env.SERP_DEBUG_LOG === 'true';

const SEARCH_TIMEOUT_MS = loadEnvNumber('SERP_SEARCH_TIMEOUT_MS', 12_000);
const MAX_RETRIES = loadEnvNumber('SERP_MAX_RETRIES', 1);

export type { SearchExecutionResult, SearchParams, SearchResult };

export interface SerpClient {
  init(): Promise<void>;
  search(params: SearchParams): Promise<SearchExecutionResult>;
  shutdown(): Promise<void>;
  stats(): ReturnType<SessionPool['stats']>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

class PooledSerpClient implements SerpClient {
  private readonly pool: SessionPool;

  constructor() {
    this.pool = new SessionPool();
  }

  async init(): Promise<void> {
    await this.pool.init();
  }

  async search(params: SearchParams): Promise<SearchExecutionResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const startedAt = Date.now();

      try {
        const execution = await withTimeout(
          searchWithBrowserPool(params, this.pool.manager),
          SEARCH_TIMEOUT_MS,
          `Search timed out after ${SEARCH_TIMEOUT_MS}ms`
        );

        if (DEBUG_LOG) {
          console.log('[serp] search finished', {
            attempt,
            results: execution.result.results.length,
            ms: Date.now() - startedAt,
          });
        }

        return execution.result;
      } catch (error) {
        lastError = error;
        if (DEBUG_LOG) {
          console.error('[serp] search failed', {
            attempt,
            ms: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error('search_failed');
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }

  stats() {
    return this.pool.stats();
  }
}

export function createSerpClient(): SerpClient {
  return new PooledSerpClient();
}
