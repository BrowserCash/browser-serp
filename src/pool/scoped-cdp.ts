import type { CDPClient } from '../cdp.js'

type EventCallback = (params: Record<string, unknown>) => void

/**
 * Thin wrapper that binds a CDPClient to a specific CDP sessionId.
 * All send() calls auto-append the bound sessionId.
 * All on()/off() calls route through the parent's session-scoped listeners.
 * close() removes scoped listeners but does NOT close the parent WebSocket.
 */
export class ScopedCDPClient {
  private readonly parent: CDPClient
  private readonly boundSessionId: string
  private readonly registered: Array<{ method: string; callback: EventCallback }> = []
  private _closed = false

  constructor(parent: CDPClient, sessionId: string) {
    this.parent = parent
    this.boundSessionId = sessionId
  }

  get sessionId(): string {
    return this.boundSessionId
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    if (this._closed) throw new Error('Scoped CDP client is closed')
    return this.parent.send(method, params, sessionId ?? this.boundSessionId)
  }

  on(method: string, callback: EventCallback): void {
    this.parent.onSession(this.boundSessionId, method, callback)
    this.registered.push({ method, callback })
  }

  off(method: string, callback: EventCallback): void {
    this.parent.offSession(this.boundSessionId, method, callback)
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    for (const { method, callback } of this.registered) {
      this.parent.offSession(this.boundSessionId, method, callback)
    }
    this.registered.length = 0
    this.parent.removeAllSessionListeners(this.boundSessionId)
  }

  get closed(): boolean {
    return this._closed || this.parent.closed
  }
}
