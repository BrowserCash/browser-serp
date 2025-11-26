# Browser SERP API

A high-performance SERP (Search Engine Results Page) API that uses [Browser.cash](https://browser.cash) to perform Google searches with concurrent session pooling.

## Features

- **Session Pooling** - Pre-warmed browser sessions for fast response times
- **Concurrent Requests** - Handle multiple searches simultaneously
- **Auto-scaling** - Sessions are recycled and replenished automatically
- **DOM Parsing** - Fast, reliable result extraction without LLM dependencies
- **Official SDK** - Uses [@browsercash/sdk](https://docs.browser.cash/docs/browser-api/using-session-api) for session management

## How It Works

1. On startup, pre-warms a pool of browser sessions via Browser.cash SDK
2. Incoming requests acquire an available session from the pool
3. Navigates to Google and extracts results using DOM selectors
4. Returns session to pool for reuse (or recycles if exhausted)

## Quick Start

```bash
cd browser-serp
cp .env.example .env   # Set your BROWSER_API_KEY
npm install
npm run dev            # Runs on http://localhost:8080
```

## Example Request

```bash
curl -X POST http://localhost:8080/api/v1/search \
  -H "content-type: application/json" \
  -d '{"q":"canadagoose mens jackets","count":5}'
```

## API Reference

### POST /api/v1/search

**Request Body:**

| Field         | Type   | Required | Description                               |
| ------------- | ------ | -------- | ----------------------------------------- |
| `q`           | string | Yes      | Search query                              |
| `count`       | number | No       | Number of results (1-100, default: 10)    |
| `country`     | string | No       | Country code for localization (e.g. "us") |
| `search_lang` | string | No       | Language code (default: "en")             |
| `freshness`   | string | No       | Time filter: day, week, month, year       |
| `safesearch`  | string | No       | Safe search: off, moderate, strict        |

**Response:**

```json
{
  "type": "search",
  "query": {
    "original": "canadagoose mens jackets",
    "show_strict_warning": false
  },
  "web": {
    "results": [
      {
        "title": "Outerwear for Men - Jackets, Vests & Bombers",
        "url": "https://www.canadagoose.com/...",
        "description": "...",
        "position": 1
      }
    ],
    "family_friendly": true
  },
  "mixed": {
    "type": "mixed",
    "main": [...],
    "top": [],
    "side": []
  }
}
```

### GET /health

Health check endpoint. Returns `{"ok": true}`.

### GET /stats

Pool statistics for monitoring.

```json
{
  "pool": {
    "available": 2,
    "inUse": 1,
    "creating": 0,
    "total": 3
  }
}
```

## Project Structure

```
src/
├── index.ts              # Fastify server setup, CORS, rate limiting
├── routes/
│   └── search.ts         # POST /api/v1/search endpoint
├── services/
│   ├── browser-cash.ts   # Session pool using @browsercash/sdk
│   └── ranking.ts        # Response formatting
├── types/
│   └── search.ts         # Zod schema & TypeScript types
└── lib/
    └── env.ts            # Environment variable helpers
```

## Environment Variables

### Required

| Variable          | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `BROWSER_API_KEY` | Your Browser.cash API key from the [Dashboard](https://browser.cash) |

### Server Configuration

| Variable          | Default | Description                  |
| ----------------- | ------- | ---------------------------- |
| `PORT`            | `8080`  | Server port                  |
| `RATE_LIMIT_MAX`  | `100`   | Max requests per minute      |
| `ALLOWED_ORIGINS` | `*`     | Comma-separated CORS origins |
| `LOG_LEVEL`       | `info`  | Fastify log level            |

### Pool Configuration

| Variable                        | Default  | Description                                   |
| ------------------------------- | -------- | --------------------------------------------- |
| `SERP_POOL_SIZE`                | `3`      | Number of concurrent browser sessions         |
| `SERP_SESSION_MAX_USES`         | `50`     | Recycle session after N searches              |
| `SERP_SESSION_MAX_AGE_MS`       | `300000` | Recycle session after 5 minutes               |
| `SERP_MAX_RETRIES`              | `2`      | Auto-retry on errors/timeouts (0 to disable)  |
| `SERP_SEARCH_TIMEOUT_MS`        | `30000`  | Max time per search attempt (30 seconds)      |
| `SERP_HEALTH_CHECK_INTERVAL_MS` | `30000`  | Background health check interval (30 seconds) |

### Debug Options

| Variable          | Default | Description                    |
| ----------------- | ------- | ------------------------------ |
| `SERP_DEBUG_HTML` | `false` | Write HTML dumps for debugging |
| `SERP_DEBUG_LOG`  | `false` | Enable verbose logging         |

## Performance Tuning

### For High Throughput

Increase pool size to handle more concurrent requests:

```env
SERP_POOL_SIZE=10
RATE_LIMIT_MAX=200
```

### For Cost Efficiency

Use fewer sessions with longer lifetimes:

```env
SERP_POOL_SIZE=2
SERP_SESSION_MAX_USES=100
SERP_SESSION_MAX_AGE_MS=600000
```

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │           Session Pool              │
                    │  ┌─────┐ ┌─────┐ ┌─────┐           │
  Request ─────────►│  │ S1  │ │ S2  │ │ S3  │  ...      │
                    │  └──┬──┘ └──┬──┘ └──┬──┘           │
                    │     │      │      │                │
                    │     ▼      ▼      ▼                │
                    │  ┌─────────────────────┐           │
                    │  │  @browsercash/sdk   │           │
                    │  └─────────────────────┘           │
                    └─────────────────────────────────────┘
                                   │
                                   ▼
                            ┌─────────────┐
                            │   Google    │
                            └─────────────┘
```

## Scripts

```bash
npm run dev    # Development with hot reload
npm run build  # Compile TypeScript to dist/
npm start      # Run compiled version
```

## References

- [Browser.cash Session API Documentation](https://docs.browser.cash/docs/browser-api/using-session-api)
- [@browsercash/sdk on npm](https://www.npmjs.com/package/@browsercash/sdk)
