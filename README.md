# Browser SERP v2

High-performance Google SERP API powered by Browser Cash using direct CDP, warm pooled sessions, and race-based attempt execution.

This is the v2 architecture:

- Direct CDP (`ws`) end-to-end
- No Patchright
- No `@browsercash/pool`
- Multi-page warm browser pool with slot/node lifecycle management
- Challenge-aware quality gating + recovery
- Serper-compatible `/api/v1/search` request/response shape

## API

### POST `/api/v1/search`

Single query request:

```bash
curl --location 'http://127.0.0.1:8080/api/v1/search' \
  --header 'Content-Type: application/json' \
  --data '{"q":"apple inc","gl":"us","hl":"en","num":10,"page":1}'
```

Example body fields:

- `q` (required)
- `gl`
- `hl`
- `location`
- `num` (1-100)
- `page` (>=1)
- `tbs` (ex: `qdr:m`)
- `autocorrect`

Mini-batch is supported by posting an array (max 100 items):

```bash
curl --location 'http://127.0.0.1:8080/api/v1/search' \
  --header 'Content-Type: application/json' \
  --data '[{"q":"apple inc"},{"q":"firefox","gl":"us","hl":"en","num":10}]'
```

Notes:

- No per-request API key header is required.
- Service credentials come from server env (`BROWSER_CASH_API_KEY` / `BROWSER_API_KEY`).

Response is Serper-style and includes:

- `searchParameters`
- `organic`
- optional `knowledgeGraph`, `answerBox`, `peopleAlsoAsk`, `topStories`, `relatedSearches`
- `credits`

### GET `/health`

```json
{ "ok": true }
```

### GET `/stats`

Returns live pool telemetry. Example:

```json
{
  "pool": {
    "size": 16,
    "available": 10,
    "active": 6,
    "totalNodes": 4,
    "totalSlots": 16,
    "inUse": 6
  }
}
```

## Environment

Required:

- `BROWSER_CASH_API_KEY` (compatibility alias: `BROWSER_API_KEY`)
- `BROWSER_POOL_TARGETS_JSON` or `SERP_POOL_SIZE`

Example:

```bash
BROWSER_CASH_API_KEY=...
BROWSER_POOL_TARGETS_JSON=[{"country":"US","type":"hosted","count":4}]
PORT=8080
```

Core tuning:

- `SERP_SEARCH_TIMEOUT_MS` (default `12000`)
- `SERP_MAX_RETRIES` (default `1`)
- `SERP_RECOVERY_ATTEMPTS` (default `1`)
- `SERP_HEDGE_DELAY_MS` (default `100`)
- `SERP_BATCH_CONCURRENCY` (default `8`)
- `BROWSER_POOL_PAGES_PER_BROWSER` (default `4`)
- `BROWSER_POOL_RACE_WIDTH` (default `3`)
- `BROWSER_POOL_ATTEMPT_TIMEOUT_MS` (default `15000`)

See [.env.example](./.env.example) for the full list.

## Local Development

```bash
npm install
npm run dev
```

## Build + Run

```bash
npm run build
npm run start
```

## Tests

```bash
npm test
```

Live smoke:

```bash
npm run test:live:smoke
```

Live load:

```bash
npm run test:live:load
```
