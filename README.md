# Browser SERP API (Demo)

A lightweight SERP API demo showing how to use [Browser.cash](https://browser.cash) for high-performance, scalable browser automation.

This project demonstrates:
- **Session Pooling** with `@browsercash/sdk` for low latency
- **DOM Extraction** of Google Search results (no LLM needed)
- **Concurrent Requests** handling with automatic session recycling

## Quick Start

### Local Development
```bash
cd browsercrawl
cp .env.example .env   # Set BROWSER_API_KEY from https://browser.cash
npm install
npm run dev            # API listens on http://localhost:8080
```

### Docker
```bash
docker build -t browser-serp .
docker run -p 8080:8080 --env-file .env browser-serp
```

## API Usage

**POST** `/api/v1/search`

```bash
curl -X POST http://localhost:8080/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{
    "q": "browser automation",
    "count": 5,
    "country": "us"
  }'
```
## Environment Variables

| Variable | Description |
|----------|-------------|
| `BROWSER_API_KEY` | **Required**. Your API key from the [Browser.cash Dashboard](https://browser.cash). |
| `SERP_POOL_SIZE` | Number of concurrent sessions (default: 3). |
| `SERP_DEBUG_LOG` | Set to `true` to enable verbose debug logging. |
| `PORT` | Server port (default: 8080). |

## Resources

- [Browser.cash Documentation](https://docs.browser.cash)
- [@browsercash/sdk](https://www.npmjs.com/package/@browsercash/sdk)
