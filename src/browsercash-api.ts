const API_BASE_URL = 'https://api.browser.cash'

export type BrowserCashSessionType = 'consumer_distributed' | 'hosted' | 'testing'

export interface BrowserCashProfileConfig {
  name: string
  persist?: boolean
  cookieOnly?: boolean
}

export interface BrowserCashCreateSessionPayload {
  nodeId?: string
  country?: string
  type?: BrowserCashSessionType
  proxyUrl?: string
  windowSize?: string
  duration?: number
  profile?: BrowserCashProfileConfig
  adblock?: boolean
  captchaSolver?: boolean
}

export interface BrowserCashSession {
  sessionId: string
  status: 'starting' | 'active' | 'completed' | 'error'
  servedBy: string
  createdAt: string
  stoppedAt: string | null
  cdpUrl: string | null
}

interface BrowserCashStopResponse {
  success: boolean
}

export class BrowserCashApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = API_BASE_URL,
    private readonly timeoutMs: number = 25_000,
  ) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('BROWSER_CASH_API_KEY is required')
    }
  }

  async createSession(payload: BrowserCashCreateSessionPayload): Promise<BrowserCashSession> {
    return this.request<BrowserCashSession>('/v1/browser/session', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async getSession(sessionId: string): Promise<BrowserCashSession> {
    const params = new URLSearchParams({ sessionId })
    return this.request<BrowserCashSession>(`/v1/browser/session?${params.toString()}`, {
      method: 'GET',
    })
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const params = new URLSearchParams({ sessionId })
    const data = await this.request<BrowserCashStopResponse>(`/v1/browser/session?${params.toString()}`, {
      method: 'DELETE',
    })
    return Boolean(data.success)
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Browser Cash API request timed out after ${this.timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }

    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // noop - non-json response
    }

    if (!res.ok) {
      const message =
        typeof json === 'object' && json !== null && 'error' in json
          ? String((json as { error?: unknown }).error ?? '')
          : `${res.status} ${res.statusText}`
      throw new Error(`Browser Cash API request failed: ${message}`)
    }

    return json as T
  }
}
