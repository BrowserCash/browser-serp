import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { UserContext } from './types.js';

export const requestLogs = sqliteTable('request_logs', {
  id:                    text('id').primaryKey(),
  service:               text('service').notNull(),
  consumer_id:           text('consumer_id').notNull(),
  org_id:                text('org_id').notNull(),
  user_id:               integer('user_id').notNull(),
  email:                 text('email').notNull(),
  endpoint:              text('endpoint').notNull(),
  query_or_url:          text('query_or_url'),
  status_code:           integer('status_code').notNull(),
  result_count:          integer('result_count').notNull().default(0),
  latency_ms:            integer('latency_ms').notNull(),
  request_body_json:     text('request_body_json'),
  response_summary_json: text('response_summary_json'),
  billed_millicents:     integer('billed_millicents').notNull().default(0),
  idempotency_key:       text('idempotency_key').notNull(),
  created_at:            text('created_at').notNull(),
});

export interface LogParams {
  service: 'browser-serp' | 'scrapekit';
  userContext: UserContext;
  endpoint: string;
  queryOrUrl?: string | null;
  statusCode: number;
  resultCount: number;
  latencyMs: number;
  requestBodyJson?: string | null;
  responseSummaryJson?: string | null;
  billedMillicents: number;
  idempotencyKey: string;
}

let _db: ReturnType<typeof drizzle> | null | undefined;

function getDb(): ReturnType<typeof drizzle> | null {
  if (_db !== undefined) return _db;

  const accountId = process.env.CF_ACCOUNT_ID;
  const databaseId = process.env.CF_D1_DATABASE_ID;
  const apiToken = process.env.CF_API_TOKEN;

  if (!accountId || !databaseId || !apiToken) {
    _db = null;
    return null;
  }

  _db = drizzle(async (sql, params) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ sql, params }),
        signal: controller.signal,
      },
    );

    if (!response.ok) throw new Error(`D1 HTTP ${response.status}`);

    const data = await response.json() as { result: Array<{ results: unknown[] }> };
    const rows = (data.result?.[0]?.results ?? []) as unknown[][];
    return { rows };
  });

  return _db;
}

export function fireLog(params: LogParams): void {
  const db = getDb();
  if (!db) return;

  void db.insert(requestLogs).values({
    id:                    randomUUID(),
    service:               params.service,
    consumer_id:           params.userContext.consumerId,
    org_id:                params.userContext.orgId,
    user_id:               params.userContext.userId,
    email:                 params.userContext.email,
    endpoint:              params.endpoint,
    query_or_url:          params.queryOrUrl ?? null,
    status_code:           params.statusCode,
    result_count:          params.resultCount,
    latency_ms:            params.latencyMs,
    request_body_json:     params.requestBodyJson ?? null,
    response_summary_json: params.responseSummaryJson ?? null,
    billed_millicents:     params.billedMillicents,
    idempotency_key:       params.idempotencyKey,
    created_at:            new Date().toISOString(),
  }).catch(() => {});
}
