import { getBrowserPoolManager, type BrowserPoolManager } from '../pool/manager.js';

export interface SessionPoolStats {
  size: number;
  available: number;
  active: number;
  totalNodes: number;
  totalSlots: number;
  inUse: number;
}

export class SessionPool {
  private readonly managerInstance: BrowserPoolManager;

  constructor() {
    this.managerInstance = getBrowserPoolManager(process.env as Record<string, unknown>);
  }

  get manager(): BrowserPoolManager {
    return this.managerInstance;
  }

  async init(): Promise<void> {
    await this.managerInstance.init();
  }

  async shutdown(): Promise<void> {
    await this.managerInstance.shutdown();
  }

  stats(): SessionPoolStats {
    const stats = this.managerInstance.getPoolStats();
    return {
      size: stats.totalSlots,
      available: stats.available,
      active: stats.inUse,
      totalNodes: stats.totalNodes,
      totalSlots: stats.totalSlots,
      inUse: stats.inUse,
    };
  }
}
