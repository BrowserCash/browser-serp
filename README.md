# Browsercrawl SERP API

Minimal SERP API that fronts Browser.cash using Google results. It spins up a Browser.cash session, drives Google via CDP, and uses an OpenRouter model to parse the SERP into results.

## Quick start (dev)

```bash
cd browsercrawl
cp .env.example .env   # set BROWSER_CASH_API_KEY and OPENROUTER_API_KEY
npm install
npm run dev            # runs on http://localhost:8080
```

Example:
```bash
curl -X POST http://localhost:8080/api/v1/search \
  -H "content-type: application/json" \
  -d '{"q":"browser automation","count":5}'
```

## Project layout
- `src/index.ts` — Fastify bootstrap, rate limits, CORS, health.
- `src/routes/search.ts` — POST `/api/v1/search` with validation and pipeline.
- `src/services/browser-cash.ts` — Browser.cash session + CDP + Google SERP fetch + OpenRouter parse.
- `src/services/ranking.ts` — Simple formatter for the response shape.
- `src/lib/env.ts` — Env helpers.
- `src/types/search.ts` — Schema/types.

## Environment
- `BROWSER_CASH_API_KEY` (required)
- `OPENROUTER_API_KEY` (required for LLM parsing)
- `BROWSER_CASH_BASE` (optional, default `https://api.browser.cash`)
- `SERP_DEBUG_HTML` (optional; set `true` to write debug HTML dumps)
- `SERP_DEBUG_LOG` (optional; set `true` for verbose LLM parser logs)
- `SERP_PERSISTENT_SESSION` (optional; set `true` to create one Browser.cash session on boot and reuse it — requests are serialized)
- `PORT` (default 8080)
- `RATE_LIMIT_MAX` (default 10 req/window)
- `RATE_LIMIT_TIME_WINDOW` (default `1 minute`)
- `ALLOWED_ORIGINS` (comma list, `*` allowed)
- `LOG_LEVEL` (default `info`)

## Notes
- Google only. Results are parsed via the `x-ai/grok-4.1-fast` model on OpenRouter.
- Debug HTML dumps are disabled by default; enable with `SERP_DEBUG_HTML=true` if needed.
- No DOM fallback is used; if the LLM returns an empty array, the API returns an empty result set.
