export interface UserContext {
  userId: number;
  consumerId: string;
  orgId: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    userContext: UserContext | null;
    requestId: string;
    requestStartMs: number;
    resultCount: number;
    responsePayload: string;
  }
}
