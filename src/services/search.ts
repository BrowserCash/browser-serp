import { SearchParams, SearchResult } from './types.js';
import { parseDomResults } from './extractor.js';
import path from 'node:path';
import fs from 'node:fs';

const DEBUG_HTML = process.env.SERP_DEBUG_HTML === "1" || process.env.SERP_DEBUG_HTML === "true";
const DEBUG_LOG = process.env.SERP_DEBUG_LOG === "1" || process.env.SERP_DEBUG_LOG === "true";

interface StepTiming {
  step: string;
  durationMs: number;
}

class TimingTracker {
  private startTime: number;
  private lastStepTime: number;
  steps: StepTiming[] = [];

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

  /** Merge steps from another tracker and sync lastStepTime to now */
  mergeSteps(otherSteps: StepTiming[]): void {
    for (const st of otherSteps) {
      this.steps.push(st);
    }
    this.lastStepTime = Date.now();
  }

  getTotalMs(): number {
    return Date.now() - this.startTime;
  }

  print(label: string): void {
    const totalMs = this.getTotalMs();
    console.log(`[serp-timing] ${label} - Total: ${totalMs}ms`);
    console.log(`[serp-timing] Step breakdown:`);
    for (const { step, durationMs } of this.steps) {
      console.log(`  - ${step}: ${durationMs}ms`);
    }
  }
}

function dumpHtml(html: string, label: string): void {
  if (!DEBUG_HTML) return;

  try {
    const outPath = path.join(process.cwd(), `serp-debug-${label}.html`);
    fs.writeFileSync(outPath, html, "utf8");
    console.log(`[serp-debug] wrote ${outPath}`);
  } catch (err) {
    console.error("[serp-debug] failed to write html dump", err);
  }
}

export async function runGoogleSearch(
  page: any,
  params: SearchParams
): Promise<{ results: SearchResult[]; blocked: boolean }> {
  const timing = new TimingTracker();
  
  const count = Math.min(Math.max(params.count ?? 10, 1), 100);
  // Request slightly more results than needed to account for non-standard result types that might be filtered
  const requestCount = Math.min(count + 5, 100);
  const hl = params.search_lang || "en";
  const gl = params.country?.toLowerCase();
  const query = encodeURIComponent(params.q);
  const baseUrl = `https://www.google.com/search?q=${query}&num=${requestCount}&hl=${encodeURIComponent(
    hl
  )}${gl ? `&gl=${encodeURIComponent(gl)}` : ""}&safe=off`;

  timing.mark("build_url");

  if (DEBUG_LOG)
    console.log("[serp] searching", { q: params.q, count, requestCount });

  try {
    await page
      .context()
      .setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  } catch (err) {
    if (DEBUG_LOG) console.warn("[serp] failed to set headers", err);
  }

  timing.mark("set_headers");

  const fetchAndParse = async (
    url: string,
    tag: string
  ): Promise<{ results: SearchResult[]; html: string; stepTimings: StepTiming[] }> => {
    const stepTimings: StepTiming[] = [];
    let lastTime = Date.now();
    
    const markStep = (step: string) => {
      const now = Date.now();
      const durationMs = now - lastTime;
      stepTimings.push({ step, durationMs });
      if (DEBUG_LOG) console.log(`[serp-timing] ${step}: ${durationMs}ms`);
      lastTime = now;
    };
    
    // Navigate to the page
    const response = await page
      .goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => null);

    markStep(`${tag}_navigation`);

    // Check if navigation succeeded
    if (!response) {
      if (DEBUG_LOG) console.log("[serp] navigation failed for", tag);
      return { results: [], html: "", stepTimings: [] };
    }

    // Wait for search results container with multiple selectors
    await page
      .waitForSelector("div#search, div#rso, div#main", { timeout: 8_000 })
      .catch(() => {});

    markStep(`${tag}_wait_container`);

    // Skip the extra wait - the container is enough
    // The previous wait_results was taking too long due to selector ambiguity

    const html = await page.content().catch(() => "");
    if (html) dumpHtml(html, tag);

    markStep(`${tag}_get_content`);

    const results = await parseDomResults(page, requestCount);

    markStep(`${tag}_parse_dom`);

    return { results, html, stepTimings };
  };

  // Try base URL first
  let { results, html: lastHtml, stepTimings } = await fetchAndParse(baseUrl, "google-base");
  
  // Add fetch timings to main tracker
  timing.mergeSteps(stepTimings);

  // If empty, try with basic HTML view (gbv=1) as fallback
  if (!results.length) {
    if (DEBUG_LOG) console.log("[serp] trying fallback URL (gbv=1)");
    timing.mark("fallback_start");
    
    const fallbackUrl = `${baseUrl}&gbv=1`;
    const fallback = await fetchAndParse(fallbackUrl, "google-fallback");
    results = fallback.results;
    lastHtml = fallback.html;
    
    timing.mergeSteps(fallback.stepTimings);
  }

  // If still empty, try one more time with a page refresh
  // This helps if the page loaded but scripts failed or content was dynamically blocked temporarily
  if (!results.length && lastHtml) {
    if (DEBUG_LOG) console.log("[serp] trying page refresh");
    timing.mark("refresh_start");
    
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 10_000 })
      .catch(() => {});
    
    timing.mark("refresh_reload");
    
    await page
      .waitForSelector("div#search, div#rso", { timeout: 5_000 })
      .catch(() => {});
    
    timing.mark("refresh_wait_container");
    
    try {
      await page.waitForSelector("div.g", { timeout: 1000 });
    } catch {
      if (DEBUG_LOG) console.log("[serp] optional retry wait timed out, proceeding");
    }
    
    timing.mark("refresh_wait_results");
    
    results = await parseDomResults(page, requestCount);
    lastHtml = await page.content().catch(() => "");
    
    timing.mark("refresh_parse_dom");
  }

  // Detect if we're blocked
  const blocked =
    !results.length &&
    /captcha-form|recaptcha|unusual traffic|consent\.google/i.test(
      lastHtml || ""
    );

  timing.mark("detect_blocked");

  if (DEBUG_LOG) {
    console.log("[serp] parsed", { count: results.length, blocked });
    timing.print(`search q="${params.q}"`);
  }

  return { results: results.slice(0, count), blocked };
}
