import type { CDPCommand, CDPMessage } from './types.js';

type EventCallback = (params: Record<string, unknown>) => void;

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function getStringField(value: unknown, key: string): string | undefined {
  const record = getRecord(value);
  if (!record) return undefined;
  const field = record[key];
  return typeof field === 'string' ? field : undefined;
}

function getNumberField(value: unknown, key: string): number | undefined {
  const record = getRecord(value);
  if (!record) return undefined;
  const field = record[key];
  return typeof field === 'number' ? field : undefined;
}

function getConnectErrorMessage(event: unknown): string | undefined {
  const direct = getStringField(event, 'message');
  if (direct) return direct;
  const nestedError = getRecord(getRecord(event)?.error);
  return nestedError ? getStringField(nestedError, 'message') : undefined;
}

export class CDPClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private listeners = new Map<string, Set<EventCallback>>();
  private sessionListeners = new Map<string, Map<string, Set<EventCallback>>>();
  private _closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.setupMessageHandler();
  }

  static connect(wsUrl: string, timeoutMs = 25_000): Promise<CDPClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`CDP WebSocket connection failed to ${wsUrl}: ${message}`));
        return;
      }

      let settled = false;

      const timeoutId = setTimeout(() => {
        rejectConnect(`CDP WebSocket connection timeout after ${timeoutMs}ms to ${wsUrl}`, true);
      }, timeoutMs);

      const cleanup = (removeErrorListener: boolean) => {
        clearTimeout(timeoutId);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('close', onClose);
        if (removeErrorListener) {
          ws.removeEventListener('error', onError);
        }
      };

      const rejectConnect = (message: string, closeSocket = false) => {
        if (settled) return;
        settled = true;
        if (closeSocket) {
          try { ws.close(); } catch {}
        }
        // Keep the error listener attached on failed handshakes so any
        // follow-up socket error event is still handled.
        cleanup(false);
        reject(new Error(message));
      };

      const onOpen = () => {
        if (settled) return;
        settled = true;
        // Connected successfully; instantiate first so runtime handlers are in place.
        const client = new CDPClient(ws);
        cleanup(true);
        resolve(client);
      };

      const onClose = (event: unknown) => {
        const code = getNumberField(event, 'code');
        const reason = getStringField(event, 'reason');
        const detail = code !== undefined || reason
          ? ` (code=${code ?? 'unknown'}${reason ? `, reason=${reason}` : ''})`
          : '';
        rejectConnect(`CDP WebSocket disconnected while connecting to ${wsUrl}${detail}`);
      };

      const onError = (event: unknown) => {
        const connectError = getConnectErrorMessage(event);
        const detail = connectError ? `: ${connectError}` : '';
        rejectConnect(`CDP WebSocket connection failed to ${wsUrl}${detail}`);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
    });
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    if (this._closed) throw new Error('CDP connection is closed');

    const id = this.nextId++;
    const command: CDPCommand = { id, method };
    if (params) command.params = params;
    if (sessionId) command.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(command));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(method: string, callback: EventCallback): void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(callback);
  }

  off(method: string, callback: EventCallback): void {
    this.listeners.get(method)?.delete(callback);
  }

  onSession(sessionId: string, method: string, callback: EventCallback): void {
    let byMethod = this.sessionListeners.get(sessionId);
    if (!byMethod) {
      byMethod = new Map();
      this.sessionListeners.set(sessionId, byMethod);
    }
    let set = byMethod.get(method);
    if (!set) {
      set = new Set();
      byMethod.set(method, set);
    }
    set.add(callback);
  }

  offSession(sessionId: string, method: string, callback: EventCallback): void {
    this.sessionListeners.get(sessionId)?.get(method)?.delete(callback);
  }

  removeAllSessionListeners(sessionId: string): void {
    this.sessionListeners.delete(sessionId);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try { this.ws.close(); } catch {}
  }

  get closed(): boolean {
    return this._closed;
  }

  private setupMessageHandler(): void {
    this.ws.addEventListener('message', (event: MessageEvent) => {
      let msg: CDPMessage;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        // Malformed CDP frame — skip silently to keep the message loop alive
        return;
      }

      // Response to a command
      if ('id' in msg && msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if ('error' in msg) {
            pending.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }

      // Event
      if ('method' in msg) {
        const eventSessionId = (msg as { sessionId?: string }).sessionId;
        if (eventSessionId) {
          // Route to session-scoped listeners first
          const byMethod = this.sessionListeners.get(eventSessionId);
          if (byMethod) {
            const callbacks = byMethod.get(msg.method);
            if (callbacks) {
              for (const cb of callbacks) {
                try { cb(msg.params); } catch {}
              }
            }
          }
        }
        // Always dispatch to global listeners (backward compat)
        const callbacks = this.listeners.get(msg.method);
        if (callbacks) {
          for (const cb of callbacks) {
            try { cb(msg.params); } catch {}
          }
        }
      }
    });

    this.ws.addEventListener('close', () => {
      this._closed = true;
      for (const [, p] of this.pending) p.reject(new Error('CDP WebSocket closed'));
      this.pending.clear();
    });

    this.ws.addEventListener('error', () => {
      for (const [, p] of this.pending) p.reject(new Error('CDP WebSocket error'));
      this.pending.clear();
    });
  }
}
