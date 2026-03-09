CREATE TABLE IF NOT EXISTS request_logs (
  id                    TEXT PRIMARY KEY,
  service               TEXT NOT NULL,
  consumer_id           TEXT NOT NULL,
  org_id                TEXT NOT NULL,
  user_id               INTEGER NOT NULL,
  email                 TEXT NOT NULL,
  endpoint              TEXT NOT NULL,
  query_or_url          TEXT,
  status_code           INTEGER NOT NULL,
  result_count          INTEGER NOT NULL DEFAULT 0,
  latency_ms            INTEGER NOT NULL,
  request_body_json     TEXT,
  response_summary_json TEXT,
  billed_millicents     INTEGER NOT NULL DEFAULT 0,
  idempotency_key       TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rl_consumer_id ON request_logs(consumer_id);
CREATE INDEX IF NOT EXISTS idx_rl_org_id      ON request_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_rl_created_at  ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_rl_service     ON request_logs(service);
