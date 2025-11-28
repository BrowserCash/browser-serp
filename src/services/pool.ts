import { chromium } from "patchright-core";
import BrowsercashSDK from "@browsercash/sdk";
import { loadEnvString, loadEnvNumber } from "../env.js";
import { ConnectedSession } from "./types.js";

const BROWSER_API_KEY = loadEnvString("BROWSER_API_KEY");
const DEBUG_LOG = process.env.SERP_DEBUG_LOG === "1" || process.env.SERP_DEBUG_LOG === "true";

// Pool configuration
const SESSION_MAX_USES = loadEnvNumber("SERP_SESSION_MAX_USES", 50);
const SESSION_MAX_AGE_MS = loadEnvNumber(
  "SERP_SESSION_MAX_AGE_MS",
  5 * 60 * 1000
);
const HEALTH_CHECK_INTERVAL_MS = loadEnvNumber(
  "SERP_HEALTH_CHECK_INTERVAL_MS",
  30_000
);

// Initialize Browser.cash SDK client
const browserCashClient = new BrowsercashSDK({ apiKey: BROWSER_API_KEY });

/**
 * Create a connected browser session using Browser.cash SDK
 */
export async function createConnectedSession(): Promise<ConnectedSession> {
  // Use the official SDK to create a session - it handles waiting for CDP URL
  const session = await browserCashClient.browser.session.create();

  if (!session.cdpUrl) {
    throw new Error("No CDP URL returned for session");
  }

  if (DEBUG_LOG)
    console.log("[session] created", { sessionId: session.sessionId });
  // Log CDP URL so it can be connected to externally if needed
  console.log("[cdp] session ready", { sessionId: session.sessionId, cdpUrl: session.cdpUrl });

  const browser = await chromium.connectOverCDP(session.cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  return {
    sessionId: session.sessionId,
    cdpUrl: session.cdpUrl,
    browser,
    page,
    createdAt: Date.now(),
    useCount: 0,
  };
}

/**
 * Close a connected session using Browser.cash SDK
 */
export async function closeConnectedSession(
  session: ConnectedSession | null
): Promise<void> {
  if (!session) return;

  try {
    await session.browser.close().catch(() => {});
  } catch (err) {
    if (DEBUG_LOG) console.warn("[session] browser close warning", err);
  }

  try {
    await browserCashClient.browser.session.stop({
      sessionId: session.sessionId,
    });
    if (DEBUG_LOG)
      console.log("[session] stopped", { sessionId: session.sessionId });
  } catch (err) {
    if (DEBUG_LOG) console.warn("[session] stop API failed", err);
  }
}

export function isSessionUsable(session: ConnectedSession | null): boolean {
  if (!session) return false;
  if (typeof session.page?.isClosed === "function" && session.page.isClosed())
    return false;
  if (session.useCount >= SESSION_MAX_USES) return false;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE_MS) return false;
  return true;
}

/**
 * Session Pool - manages multiple concurrent browser sessions with strict limits
 */
export class SessionPool {
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

    const warmupPromises: Promise<void>[] = [];
    for (let i = 0; i < this.size; i++) {
      warmupPromises.push(this.addSession());
    }

    // Wait for at least one session to be ready
    await Promise.race(warmupPromises);

    // Wait for all warmup to complete
    await Promise.allSettled(warmupPromises);

    this.startHealthCheck();

    if (DEBUG_LOG) console.log("[pool] initialized", { ...this.stats() });
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      if (this.closed) return;
      this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  private performHealthCheck(): void {
    if (DEBUG_LOG)
      console.log("[pool] health check starting", { ...this.stats() });

    const toRemove: ConnectedSession[] = [];

    for (const session of this.available) {
      if (!isSessionUsable(session)) {
        toRemove.push(session);
      }
    }

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
        closeConnectedSession(session).catch((err) => {
          if (DEBUG_LOG) console.warn("[pool] failed to close stale session", err);
        });
      }
    }

    this.replenishPool();

    if (DEBUG_LOG)
      console.log("[pool] health check complete", { ...this.stats() });
  }

  private replenishPool(): void {
    const deficit = this.size - this.totalCount;
    if (deficit <= 0) return;

    if (DEBUG_LOG)
      console.log("[pool] replenishing", { deficit, ...this.stats() });

    this.addSession().catch((err) => {
      if (DEBUG_LOG) console.error("[pool] replenish failed", err);
    });
  }

  private async addSession(): Promise<void> {
    if (this.closed) return;

    this.creating++;

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
        await closeConnectedSession(session);
        return;
      }

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

      if (this.waitQueue.length > 0) {
        const waiter = this.waitQueue.shift()!;
        this.inUse.add(session);
        session.useCount++;
        // Log a browser miss whenever a request had to wait for a fresh browser
        console.log("[browser miss] created new browser session for pending request", {
          sessionId: session.sessionId,
        });
        if (DEBUG_LOG)
          console.log("[pool] session created and assigned to waiter", {
            sessionId: session.sessionId,
            ...this.stats(),
          });
        waiter.resolve(session);
      } else {
        this.available.push(session);
        // Log when a session with a CDP URL becomes available in the pool
        console.log("[cdp] session added to pool", {
          sessionId: session.sessionId,
          cdpUrl: session.cdpUrl,
        });
        if (DEBUG_LOG)
          console.log("[pool] session added to pool", {
            sessionId: session.sessionId,
            ...this.stats(),
          });
      }

      if (this.totalCount < this.size && !this.closed) {
        setImmediate(() => this.addSession().catch((err) => {
          if (DEBUG_LOG) console.error("[pool] recursive addSession failed", err);
        }));
      }
    } catch (err) {
      if (DEBUG_LOG) console.error("[pool] failed to create session", err);

      if (this.waitQueue.length > 0) {
        const waiter = this.waitQueue.shift()!;
        waiter.reject(err instanceof Error ? err : new Error(String(err)));
      }

      if (!this.closed && this.totalCount < this.size) {
        setTimeout(() => this.addSession().catch((err) => {
          if (DEBUG_LOG) console.error("[pool] retry addSession failed", err);
        }), 5000);
      }
    } finally {
      this.creating--;
    }
  }

  async acquire(): Promise<ConnectedSession> {
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
      closeConnectedSession(session).catch((err) => {
        if (DEBUG_LOG) console.warn("[pool] failed to close session during acquire", err);
      });
    }

    this.creating++;

    if (this.totalCount <= this.size) {
      if (DEBUG_LOG)
        console.log("[pool] no available sessions, creating on-demand", {
          ...this.stats(),
        });

      try {
        // Log a browser miss whenever a request forces on-demand creation
        console.log("[browser miss] no available sessions; creating new browser session on-demand");
        const session = await createConnectedSession();

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
        } else {
          this.creating--;
          this.inUse.add(session);
          session.useCount++;
          // Log when a session is created on-demand and handed to the requester
          console.log("[cdp] on-demand session assigned", {
            sessionId: session.sessionId,
            cdpUrl: session.cdpUrl,
          });
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
      this.creating--;
    }

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
      closeConnectedSession(session).catch((err) => {
        if (DEBUG_LOG) console.warn("[pool] failed to close released session", err);
      });

      this.replenishPool();
    } else {
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

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

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
      allSessions.map((s) => closeConnectedSession(s).catch((err) => {
        if (DEBUG_LOG) console.warn("[pool] shutdown close error", err);
      }))
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

