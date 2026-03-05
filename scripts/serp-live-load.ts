import { createSerpClient } from '../src/services/serp.js';

const hasKey = Boolean(process.env.BROWSER_CASH_API_KEY || process.env.BROWSER_API_KEY);
if (!hasKey) {
  console.error('Missing Browser Cash key. Set BROWSER_CASH_API_KEY or BROWSER_API_KEY.');
  process.exit(1);
}

const TOTAL_REQUESTS = parseInt(process.env.SERP_LOAD_TOTAL_REQUESTS || '40', 10);
const CONCURRENCY = parseInt(process.env.SERP_LOAD_CONCURRENCY || '8', 10);
const P50_SLO_MS = parseInt(process.env.SERP_LOAD_P50_SLO_MS || '3000', 10);
const P95_SLO_MS = parseInt(process.env.SERP_LOAD_P95_SLO_MS || '6000', 10);
const SUCCESS_SLO = parseFloat(process.env.SERP_LOAD_SUCCESS_SLO || '0.95');

const payload = {
  q: process.env.SERP_LOAD_QUERY || 'best noise cancelling headphones',
  count: 10,
  country: 'us',
  search_lang: 'en' as const,
};

interface Sample {
  ms: number;
  ok: boolean;
  resultCount: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] || 0;
}

async function worker(client: ReturnType<typeof createSerpClient>, iterations: number): Promise<Sample[]> {
  const samples: Sample[] = [];

  for (let i = 0; i < iterations; i++) {
    const started = Date.now();
    try {
      const { results } = await client.search(payload);
      const ms = Date.now() - started;
      samples.push({
        ms,
        ok: results.length > 0,
        resultCount: results.length,
      });
    } catch {
      const ms = Date.now() - started;
      samples.push({
        ms,
        ok: false,
        resultCount: 0,
      });
    }
  }

  return samples;
}

async function main(): Promise<void> {
  const client = createSerpClient();

  try {
    await client.init();

    // Warm-up request.
    await client.search(payload).catch(() => {});

    const workerCount = Math.max(1, Math.min(CONCURRENCY, TOTAL_REQUESTS));
    const base = Math.floor(TOTAL_REQUESTS / workerCount);
    const remainder = TOTAL_REQUESTS % workerCount;

    const jobs = Array.from({ length: workerCount }, (_, idx) => base + (idx < remainder ? 1 : 0));
    const chunks = await Promise.all(jobs.map((count) => worker(client, count)));
    const samples = chunks.flat();

    const successful = samples.filter((s) => s.ok);
    const successRate = successful.length / Math.max(1, samples.length);
    const latencies = successful.map((s) => s.ms);

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    console.log(
      JSON.stringify({
        totalRequests: samples.length,
        successful: successful.length,
        successRate,
        p50,
        p95,
      })
    );

    if (successRate < SUCCESS_SLO) {
      throw new Error(`Success rate SLO failed: ${successRate.toFixed(3)} < ${SUCCESS_SLO}`);
    }
    if (p50 > P50_SLO_MS) {
      throw new Error(`p50 latency SLO failed: ${p50}ms > ${P50_SLO_MS}ms`);
    }
    if (p95 > P95_SLO_MS) {
      throw new Error(`p95 latency SLO failed: ${p95}ms > ${P95_SLO_MS}ms`);
    }
  } finally {
    await client.shutdown().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
