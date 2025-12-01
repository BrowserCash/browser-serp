import type { SearchParams, SearchResult } from './types.js';
import { parseDomResults } from './extractor.js';

const DEBUG_LOG = process.env.SERP_DEBUG_LOG === '1' || process.env.SERP_DEBUG_LOG === 'true';

interface StepTiming {
  step: string;
  durationMs: number;
}

/**
 * Performance timing tracker for search operations
 */
class TimingTracker {
  private readonly startTime: number;
  private lastStepTime: number;
  readonly steps: StepTiming[] = [];

  constructor() {
    this.startTime = Date.now();
    this.lastStepTime = this.startTime;
  }

  mark(step: string): void {
    const now = Date.now();
    const durationMs = now - this.lastStepTime;
    this.steps.push({ step, durationMs });
    this.lastStepTime = now;
  }

  mergeSteps(otherSteps: StepTiming[]): void {
    for (const st of otherSteps) {
      this.steps.push(st);
    }
    this.lastStepTime = Date.now();
  }

  getTotalMs(): number {
    return Date.now() - this.startTime;
  }

  print(label: string, logFn: (line: string) => void = console.log): void {
    const totalMs = this.getTotalMs();
    logFn(`[serp-timing] ${label} - Total: ${totalMs}ms`);
    logFn('[serp-timing] Step breakdown:');
    for (const { step, durationMs } of this.steps) {
      logFn(`  - ${step}: ${durationMs}ms`);
    }
  }
}

/**
 * Debug logger with elapsed time prefix
 */
function createLogger(startTime: number) {
  return (...args: unknown[]) => {
    if (!DEBUG_LOG) return;
    const elapsed = Date.now() - startTime;
    if (args.length > 0 && typeof args[0] === 'string') {
      console.log(`[+${elapsed}ms] ${args[0]}`, ...args.slice(1));
    } else {
      console.log(`[+${elapsed}ms]`, ...args);
    }
  };
}

/**
 * Run a Google search and extract results
 */
export async function runGoogleSearch(
  page: any,
  params: SearchParams
): Promise<{ results: SearchResult[]; blocked: boolean }> {
  const timing = new TimingTracker();
  const t0 = Date.now();
  const log = createLogger(t0);

  // Attach page event listeners for debugging
  let listenersAttached = false;
  const onClose = () => log('[page] close event');
  const onCrash = () => log('[page] crash event');

  try {
    if (DEBUG_LOG && typeof page?.on === 'function') {
      page.on('close', onClose);
      page.on('crash', onCrash);
      listenersAttached = true;
    }

    const count = Math.min(Math.max(params.count ?? 10, 1), 100);
    const requestCount = Math.min(count + 5, 100); // Request extra to account for filtered results
    const hl = params.search_lang || 'en';
    const gl = params.country?.toLowerCase();
    const query = encodeURIComponent(params.q);

    const baseUrl = `https://www.google.com/search?q=${query}&num=${requestCount}&hl=${encodeURIComponent(hl)}${gl ? `&gl=${encodeURIComponent(gl)}` : ''}&safe=off`;

    timing.mark('build_url');

    if (DEBUG_LOG) {
      log('[serp] searching', { q: params.q, count, requestCount });
    }

    // Navigate and parse results
    const { results: initialResults, stepTimings } = await fetchAndParse(page, baseUrl, 'google-search', log);
    timing.mergeSteps(stepTimings);

    let results = initialResults;

    // Retry with page refresh if no results (helps with dynamic blocking)
    if (results.length === 0) {
      if (DEBUG_LOG) log('[serp] trying page refresh');
      timing.mark('refresh_start');

      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 4_000 });
      } catch (err) {
        if (DEBUG_LOG) log('[serp] refresh failed:', err instanceof Error ? err.message : err);
      }
      timing.mark('refresh_reload');

      try {
        await page.waitForSelector('div#search, div#rso', { timeout: 2_000 });
      } catch {
        // Container may not exist, continue anyway
      }
      timing.mark('refresh_wait_container');

      try {
        await page.waitForSelector('div.g', { timeout: 500 });
      } catch {
        if (DEBUG_LOG) log('[serp] optional retry wait timed out, proceeding');
      }
      timing.mark('refresh_wait_results');

      results = await parseDomResults(page, requestCount);
      timing.mark('refresh_parse_dom');
    }

    // Pagination: fetch more pages if needed
    let pageNum = 1;
    const MAX_PAGES = 5;

    while (results.length < count && pageNum < MAX_PAGES) {
      try {
        if (DEBUG_LOG) {
          log(`[serp] clicking next page (current: ${results.length}, target: ${count})`);
        }

        const currentURL = page.url();
        const newDestUrl = new URL(currentURL);
        newDestUrl.searchParams.set('start', (pageNum * 10).toString());

        await page.evaluate((url: string) => {
          window.location.href = url;
        }, newDestUrl.toString());

        // Wait for URL to change
        while (page.url() === currentURL) {
          await page.waitForTimeout(10);
        }

        if (DEBUG_LOG) log('[serp] pagination detected change');

        // Parse new results
        let newResults = await parseDomResults(page, requestCount);

        // Count unique results
        const existingUrls = new Set(results.map((r) => r.url));
        let newUnique = newResults.filter((r) => !existingUrls.has(r.url)).length;

        if (DEBUG_LOG) log('[serp] pagination new unique results:', newUnique);

        // If no new results, wait and retry once
        if (newUnique === 0) {
          if (DEBUG_LOG) log('[serp] pagination no new results, retrying parse');
          await page.waitForTimeout(500);
          newResults = await parseDomResults(page, requestCount);
          newUnique = newResults.filter((r) => !existingUrls.has(r.url)).length;

          if (newUnique === 0) {
            if (DEBUG_LOG) log('[serp] pagination failed to get new results, stopping');
            break;
          }
        }

        // Add unique results
        for (const r of newResults) {
          if (!existingUrls.has(r.url)) {
            results.push(r);
          }
        }
        pageNum++;
      } catch (err) {
        if (DEBUG_LOG) log('[serp] pagination error:', err instanceof Error ? err.message : err);
        break;
      }
    }

    const blocked = results.length === 0;
    timing.mark('detect_blocked');

    if (DEBUG_LOG) {
      log('[serp] parsed', { count: results.length, blocked });
      timing.print(`search q="${params.q}"`, (line) => log(line));
    }

    return { results: results.slice(0, count), blocked };
  } finally {
    // Cleanup listeners
    if (listenersAttached && typeof page?.off === 'function') {
      try {
        page.off('close', onClose);
        page.off('crash', onCrash);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Navigate to URL and parse search results
 */
async function fetchAndParse(
  page: any,
  url: string,
  tag: string,
  log: (...args: unknown[]) => void
): Promise<{ results: SearchResult[]; stepTimings: StepTiming[] }> {
  const stepTimings: StepTiming[] = [];
  let lastTime = Date.now();

  const markStep = (step: string) => {
    const now = Date.now();
    const durationMs = now - lastTime;
    stepTimings.push({ step, durationMs });
    if (DEBUG_LOG) log(`[serp-timing] ${step}: ${durationMs}ms`);
    lastTime = now;
  };

  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  } catch (err) {
    if (DEBUG_LOG) log('[serp] navigation error:', err instanceof Error ? err.message : err);
    return { results: [], stepTimings: [] };
  }

  if (!response) {
    if (DEBUG_LOG) log('[serp] navigation failed for', tag);
    return { results: [], stepTimings: [] };
  }

  markStep(`${tag}_navigation`);

  const results = await parseDomResults(page, 100);
  markStep(`${tag}_parse_dom`);

  return { results, stepTimings };
}
