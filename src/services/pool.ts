import { chromium } from 'patchright-core';
import { SessionPool as SharedSessionPool } from '@browsercash/pool';
import { loadEnvString, loadEnvNumber } from '../env.js';
import type { ConnectedSession } from './types.js';

const BROWSER_API_KEY = loadEnvString('BROWSER_API_KEY');
const DEBUG_LOG = process.env.SERP_DEBUG_LOG === '1' || process.env.SERP_DEBUG_LOG === 'true';

// Pool configuration
const SESSION_MAX_USES = loadEnvNumber('SERP_SESSION_MAX_USES', 50);
const SESSION_MAX_AGE_MS = loadEnvNumber('SERP_SESSION_MAX_AGE_MS', 5 * 60 * 1000);
const HEALTH_CHECK_INTERVAL_MS = loadEnvNumber('SERP_HEALTH_CHECK_INTERVAL_MS', 10_000);

/**
 * Thin adapter to configure the shared SessionPool with createPage enabled.
 * acquire() returns a session containing a ready 'page' property.
 */
export class SessionPool {
  private pool: SharedSessionPool;

  constructor(private readonly size: number) {
    this.pool = new SharedSessionPool({
      apiKey: BROWSER_API_KEY,
      chromium: chromium as any,
      size,
      maxUses: SESSION_MAX_USES,
      maxAgeMs: SESSION_MAX_AGE_MS,
      enableHealthCheck: true,
      healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
      enableWaitQueue: true,
      enableDisconnectHandling: true,
      // createPage is available in newer versions of @browsercash/pool
      // Cast to any to avoid type errors if using older published types
      ...( { createPage: true } as any ),
      debug: DEBUG_LOG,
    } as any);
  }

  async init(): Promise<void> {
    await this.pool.init();
  }

  async acquire(): Promise<ConnectedSession> {
    const pooled = await this.pool.acquire();
    // Return the same underlying object to preserve identity for release()
    return pooled as unknown as ConnectedSession;
  }

  release(session: ConnectedSession, error?: boolean): void {
    this.pool.release(session as any, error);
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }

  stats() {
    return this.pool.stats();
  }
}
