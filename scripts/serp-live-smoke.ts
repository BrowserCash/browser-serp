import { createSerpClient } from '../src/services/serp.js';

const requiredEnv = ['BROWSER_CASH_API_KEY', 'BROWSER_API_KEY'];
const hasKey = requiredEnv.some((name) => Boolean(process.env[name]));

if (!hasKey) {
  console.error('Missing Browser Cash key. Set BROWSER_CASH_API_KEY or BROWSER_API_KEY.');
  process.exit(1);
}

const queries = [
  { q: 'OpenAI API pricing', count: 10, country: 'us', search_lang: 'en' as const },
  { q: 'latest typescript release notes', count: 10, country: 'us', search_lang: 'en' as const },
  { q: 'best coffee shops in seattle', count: 10, country: 'us', search_lang: 'en' as const },
  { q: 'kubernetes ingress controller comparison', count: 10, country: 'us', search_lang: 'en' as const },
  { q: 'deutsche bahn fahrplan', count: 10, country: 'de', search_lang: 'de' as const },
];

function uniqueUrls(results: Array<{ url: string }>): number {
  return new Set(results.map((item) => item.url)).size;
}

async function main(): Promise<void> {
  const client = createSerpClient();
  const started = Date.now();

  try {
    await client.init();

    let failed = 0;
    for (const query of queries) {
      const qStart = Date.now();
      const { results } = await client.search(query);
      const ms = Date.now() - qStart;

      const ok =
        results.length >= Math.min(query.count, 5) &&
        uniqueUrls(results) === results.length &&
        results.every((r) => r.title.trim().length > 0 && r.url.startsWith('http'));

      if (!ok) {
        failed += 1;
      }

      console.log(
        JSON.stringify({
          query: query.q,
          ms,
          count: results.length,
          unique: uniqueUrls(results),
          ok,
        })
      );
    }

    const elapsed = Date.now() - started;
    console.log(JSON.stringify({ phase: 'summary', totalQueries: queries.length, failed, elapsed }));

    if (failed > 0) {
      throw new Error(`Smoke test failed for ${failed}/${queries.length} queries`);
    }
  } finally {
    await client.shutdown().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
