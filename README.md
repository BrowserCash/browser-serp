# Browsercrawl SERP API (MVP scaffold)

This folder is a starter for a SERP API that fronts Browser.cash. It includes:

- A Fastify server with `/api/v1/search`
- Env plumbing and rate limiting
- Stubs for Browser.cash dispatch + result formatting
- Example request schema matching the outline

## Quick start (dev)

```
cd browsercrawl
cp .env.example .env   # fill BROWSER_CASH_API_KEY (and BROWSER_CASH_BASE if not default)
npm install
npm run dev
# Server runs on http://localhost:8080 (default)
```

Example request:
```
curl -X POST http://localhost:8080/api/v1/search \
  -H "content-type: application/json" \
  -d '{"q":"browser automation","count":5}'
```

## Project layout
- `src/index.ts` — Fastify bootstrap, rate limits, CORS, health check.
- `src/routes/search.ts` — POST `/api/v1/search` with validation and stubbed pipeline.
- `src/services/browser-cash.ts` — Placeholder call into Browser.cash API (replace with real runner).
- `src/services/ranking.ts` — Placeholder formatter for SERP response shape.
- `src/lib/env.ts` — Typed env helpers.
- `src/types/search.ts` — Shared schema/types for search.

## Env
- `BROWSER_CASH_API_KEY` (required)
- `BROWSER_CASH_BASE` (optional, default `https://api.browser.cash`)
- `PORT` (default 8080)
- `RATE_LIMIT_MAX` (default 10 req/window)
- `RATE_LIMIT_TIME_WINDOW` (default `1 minute`)
- `ALLOWED_ORIGINS` (comma list, `*` allowed)

## Next steps
- Replace `dispatchBrowserQuery` with real Browser.cash session/task flow (navigate, extract SERP features).
- Implement result extraction + ranking in `ranking.ts`.
- Add API key auth + tiered rate limits.
- Add caching layer and logging/metrics.
- Expand endpoints (`/images`, `/news`, `/videos`, `/local`, `/ai_summary`, etc.).
