import { chromium } from 'patchright-core';
import { SessionPool as SharedSessionPool, type PooledSession } from '@browsercash/pool';
import { loadEnvString, loadEnvNumber } from '../env.js';
import type { ConnectedSession } from './types.js';

const BROWSER_API_KEY = loadEnvString('BROWSER_API_KEY');
const DEBUG_LOG = process.env.SERP_DEBUG_LOG === '1' || process.env.SERP_DEBUG_LOG === 'true';

// Pool configuration
const SESSION_MAX_USES = loadEnvNumber('SERP_SESSION_MAX_USES', 50);
const SESSION_MAX_AGE_MS = loadEnvNumber('SERP_SESSION_MAX_AGE_MS', 5 * 60 * 1000);
const HEALTH_CHECK_INTERVAL_MS = loadEnvNumber('SERP_HEALTH_CHECK_INTERVAL_MS', 10_000);

/**
 * Wrapper around shared SessionPool that provides ConnectedSession with page
 */
export class SessionPool {
  private pool: SharedSessionPool;
  private pageMap = new Map<string, any>(); // sessionId -> page

  constructor(private size: number) {
    this.pool = new SharedSessionPool({
      apiKey: BROWSER_API_KEY,
      chromium: chromium as any, // patchright-core has same API
      size,
      maxUses: SESSION_MAX_USES,
      maxAgeMs: SESSION_MAX_AGE_MS,
      enableHealthCheck: true,
      healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
      enableWaitQueue: true,
      enableDisconnectHandling: true,
      debug: DEBUG_LOG,
    });
  }

  async init(): Promise<void> {
    await this.pool.init();
  }

  /**
   * Acquire a session with a ready page
   */
  async acquire(): Promise<ConnectedSession> {
    const session = await this.pool.acquire();
    
    // Get or create page for this session
    let page = this.pageMap.get(session.sessionId);
    const browser = session.browser as any;
    
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      // Create new page in existing context
      const contexts = browser.contexts?.() ?? [];
      const context = contexts[0] ?? await browser.newContext();
      page = await context.newPage();
      this.pageMap.set(session.sessionId, page);
      
      if (DEBUG_LOG) {
        console.log('[pool] created page for session', { sessionId: session.sessionId });
      }
    }

    return {
      sessionId: session.sessionId,
      cdpUrl: (session as any).cdpUrl || '',
      browser: session.browser,
      page,
      createdAt: session.createdAt,
      useCount: session.useCount,
      _pooledSession: session, // Store reference for release
    } as ConnectedSession & { _pooledSession: PooledSession };
  }

  /**
   * Release a session back to the pool
   */
  release(session: ConnectedSession & { _pooledSession?: PooledSession }, error?: boolean): void {
    const pooledSession = session._pooledSession;
    
    if (!pooledSession) {
      if (DEBUG_LOG) {
        console.warn('[pool] release called without _pooledSession reference');
      }
      return;
    }

    // If error or session is bad, clean up the page
    if (error) {
      const page = this.pageMap.get(session.sessionId);
      if (page) {
        page.close().catch(() => {});
        this.pageMap.delete(session.sessionId);
      }
    }

    this.pool.release(pooledSession, error);
  }

  async shutdown(): Promise<void> {
    // Close all pages
    for (const page of this.pageMap.values()) {
      try {
        await page.close();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.pageMap.clear();
    
    await this.pool.shutdown();
  }

  stats() {
    return this.pool.stats();
  }
}

/**
 * Check if a session is still usable
 */
export function isSessionUsable(session: ConnectedSession | null): boolean {
  if (!session) return false;
  if (typeof session.browser?.isConnected === 'function' && !session.browser.isConnected()) return false;
  if (typeof session.page?.isClosed === 'function' && session.page.isClosed()) return false;
  return true;
}

// Legacy exports for compatibility (no longer used but kept for reference)
export async function createConnectedSession(): Promise<ConnectedSession> {
  throw new Error('Use SessionPool.acquire() instead of createConnectedSession()');
}

export async function closeConnectedSession(session: ConnectedSession | null): Promise<void> {
  throw new Error('Use SessionPool.release() instead of closeConnectedSession()');
}
