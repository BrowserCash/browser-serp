export interface CDPCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CDPResponse {
  id: number;
  result: Record<string, unknown>;
  sessionId?: string;
}

export interface CDPErrorResponse {
  id: number;
  error: { code: number; message: string; data?: string };
  sessionId?: string;
}

export interface CDPEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export type CDPMessage = CDPResponse | CDPErrorResponse | CDPEvent;
