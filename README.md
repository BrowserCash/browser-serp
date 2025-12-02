<div align="center">
  <h1>🔍 Browser SERP</h1>
  <p>
    <strong>High-performance Google SERP API powered by remote browsers.</strong>
  </p>
  <p>
    Powered by <a href="https://browser.cash/developers">Browser.cash</a> remote browsers.
  </p>

  <p>
    <a href="#features">Features</a> •
    <a href="#quick-start">Quick Start</a> •
    <a href="#api-reference">API Reference</a> •
    <a href="#configuration">Configuration</a> •
    <a href="#docker">Docker</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" alt="Node.js Version">
    <img src="https://img.shields.io/badge/typescript-5.6-blue" alt="TypeScript">
    <img src="https://img.shields.io/badge/powered%20by-browser.cash-orange" alt="Visit Browser.cash">
  </p>

  <p>
    <a href="https://x.com/aibrowsers">
      <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" />
    </a>
    <a href="https://linkedin.com/company/megatera">
      <img src="https://img.shields.io/badge/Follow%20on%20LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" alt="Follow on LinkedIn" />
    </a>
    <a href="https://discord.gg/F9afFJPtYb">
      <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
    </a>
  </p>

  <br>

  <p>
    💡 <strong>Pro Tip:</strong> Use this with 
    <a href="https://github.com/BrowserCash/teracrawl"><strong>Teracrawl</strong></a> 
    to convert these search results into full LLM-ready Markdown content.
  </p>
</div>

---

## 🚀 What is Browser SERP?

**Browser SERP** is a lightweight, high-performance API that provides real-time Google Search results. It uses managed remote browsers to bypass anti-bot detection and deliver real-time SERP data for your applications.

Unlike traditional SERP APIs that can be slow or expensive, Browser SERP is optimized for speed and scalability, making it perfect for AI agents, RAG pipelines, and market research tools.

### Why use Browser SERP?

- **⚡ Ultra-Fast Results**: Leverages connection pooling to keep browsers hot and ready.
- **🛡️ Reliable Access**: Uses residential-grade remote browsers to ensure high success rates.
- **🧹 Clean JSON Output**: Parses complex SERP layouts into structured, easy-to-consume JSON.
- **🏎️ High Concurrency**: Built-in <a href="https://github.com/BrowserCash/browser-pool">session management</a> handles multiple parallel requests effortlessly.

## <a name="features"></a>✨ Features

- **Live Google Search**: Get real-time results for any query.
- **Smart Extraction**: Extracts organic results, snippets, and metadata.
- **Session Pooling**: Automatically manages browser lifecycles for optimal performance.
- **Rate Limiting**: Built-in protection against abuse.
- **Docker Ready**: Deploy anywhere with a lightweight container.

## <a name="quick-start"></a>🛠️ Quick Start

### Prerequisites

1.  **Node.js 18+** installed.
2.  A **[Browser.cash](https://browser.cash/developers)** API Key.

### Installation

```bash
# Clone the repository
git clone https://github.com/BrowserCash/browser-serp.git
cd browser-serp

# Install dependencies
npm install
```

### Configuration

Copy the example environment file and configure your settings:

```bash
cp .env.example .env
```

Open `.env` and set your `BROWSER_API_KEY`:

```env
BROWSER_API_KEY=your_browser_cash_api_key_here
```

### Running the Server

```bash
# Development mode
npm run dev

# Production build & start
npm run build
npm start
```

The server will start at `http://0.0.0.0:8080`.

## <a name="api-reference"></a>📚 API Reference

### 1. Search

Performs a Google search and returns structured results.

**Endpoint:** `POST /api/v1/search`

**CURL Request:**

```bash
curl -X POST http://localhost:8080/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{
    "q": "browser automation",
    "count": 5,
    "country": "us"
  }'
```

| Field     | Type     | Default      | Description                                            |
| :-------- | :------- | :----------- | :----------------------------------------------------- |
| `q`       | `string` | **Required** | The search query.                                      |
| `count`   | `number` | `5`          | Number of results to return (max 20).                  |
| `country` | `string` | `us`         | Country code for localized results (e.g., `uk`, `de`). |

**Response:**

```json
{
  "web": {
    "total": 135000000,
    "results": [
      {
        "title": "Browser Automation | The Ultimate Guide",
        "url": "https://example.com/guide",
        "description": "Learn everything about browser automation..."
      },
      {
        "title": "Top 10 Browser Automation Tools",
        "url": "https://example.com/tools",
        "description": "A comparison of the best tools for..."
      }
    ]
  }
}
```

### 2. Health Check

**Endpoint:** `GET /health`

**CURL Request:**

```bash
curl http://localhost:8080/health
```

**Response:**

```json
{
  "ok": true
}
```

### 3. Pool Statistics

Get current browser session pool status.

**Endpoint:** `GET /stats`

**CURL Request:**

```bash
curl http://localhost:8080/stats
```

**Response:**

```json
{
  "pool": {
    "size": 3,
    "available": 2,
    "active": 1
  }
}
```

## <a name="configuration"></a>⚙️ Configuration

### Server & Infrastructure

| Variable          | Default      | Description                                       |
| :---------------- | :----------- | :------------------------------------------------ |
| `BROWSER_API_KEY` | **Required** | Your Browser.cash API key.                        |
| `PORT`            | `8080`       | Port for the API server.                          |
| `LOG_LEVEL`       | `info`       | Logging level (`debug`, `info`, `warn`, `error`). |
| `ALLOWED_ORIGINS` | `*`          | CORS allowed origins (comma-separated).           |

### Performance Tuning

| Variable         | Default | Description                                        |
| :--------------- | :------ | :------------------------------------------------- |
| `SERP_POOL_SIZE` | `3`     | Number of concurrent browser sessions to maintain. |
| `RATE_LIMIT_MAX` | `100`   | Max requests per minute per IP.                    |

## <a name="docker"></a>🐳 Docker

You can run Browser SERP easily using Docker.

### Build & Run

```bash
# Build the image
docker build -t browser-serp .

# Run with env file
docker run -p 8080:8080 --env-file .env browser-serp
```

### Docker Compose

```yaml
version: "3.8"
services:
  serp:
    build: .
    ports:
      - "8080:8080"
    environment:
      - BROWSER_API_KEY=${BROWSER_API_KEY}
      - SERP_POOL_SIZE=3
```

## 🤝 Contributing

Contributions are welcome! We appreciate your help in making Browser SERP better.

### How to Contribute

1.  **Fork the Project**: click the 'Fork' button at the top right of this page.
2.  **Create your Feature Branch**: `git checkout -b feature/AmazingFeature`
3.  **Commit your Changes**: `git commit -m 'Add some AmazingFeature'`
4.  **Push to the Branch**: `git push origin feature/AmazingFeature`
5.  **Open a Pull Request**: Submit your changes for review.

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.
