import { SearchParams, SearchResult } from './types.js';
import { parseDomResults } from './extractor.js';
import path from 'node:path';
import fs from 'node:fs';

const DEBUG_HTML = process.env.SERP_DEBUG_HTML === "1" || process.env.SERP_DEBUG_HTML === "true";
const DEBUG_LOG = process.env.SERP_DEBUG_LOG === "1" || process.env.SERP_DEBUG_LOG === "true";

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
  const count = Math.min(Math.max(params.count ?? 10, 1), 100);
  // Request slightly more results than needed to account for non-standard result types that might be filtered
  const requestCount = Math.min(count + 5, 100);
  const hl = params.search_lang || "en";
  const gl = params.country?.toLowerCase();
  const query = encodeURIComponent(params.q);
  const baseUrl = `https://www.google.com/search?q=${query}&num=${requestCount}&hl=${encodeURIComponent(
    hl
  )}${gl ? `&gl=${encodeURIComponent(gl)}` : ""}&safe=off`;

  if (DEBUG_LOG)
    console.log("[serp] searching", { q: params.q, count, requestCount });

  try {
    await page
      .context()
      .setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  } catch (err) {
    if (DEBUG_LOG) console.warn("[serp] failed to set headers", err);
  }

  const fetchAndParse = async (
    url: string,
    tag: string
  ): Promise<{ results: SearchResult[]; html: string }> => {
    // Navigate to the page
    const response = await page
      .goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => null);

    // Check if navigation succeeded
    if (!response) {
      if (DEBUG_LOG) console.log("[serp] navigation failed for", tag);
      return { results: [], html: "" };
    }

    // Wait for search results container with multiple selectors
    await page
      .waitForSelector("div#search, div#rso, div#main", { timeout: 8_000 })
      .catch(() => {});

    // Wait for at least one actual result item to ensure content is rendered
    // This replaces arbitrary sleep with a condition-based wait
    try {
      await page.waitForSelector("div.g, div[data-header-feature], div#rso > div", { timeout: 2000 });
    } catch {
      if (DEBUG_LOG) console.log("[serp] optional results wait timed out, proceeding");
    }

    const html = await page.content().catch(() => "");
    if (html) dumpHtml(html, tag);

    const results = await parseDomResults(page, requestCount);
    return { results, html };
  };

  // Try base URL first
  let { results, html: lastHtml } = await fetchAndParse(baseUrl, "google-base");

  // If empty, try with basic HTML view (gbv=1) as fallback
  if (!results.length) {
    if (DEBUG_LOG) console.log("[serp] trying fallback URL (gbv=1)");
    const fallbackUrl = `${baseUrl}&gbv=1`;
    const fallback = await fetchAndParse(fallbackUrl, "google-fallback");
    results = fallback.results;
    lastHtml = fallback.html;
  }

  // If still empty, try one more time with a page refresh
  // This helps if the page loaded but scripts failed or content was dynamically blocked temporarily
  if (!results.length && lastHtml) {
    if (DEBUG_LOG) console.log("[serp] trying page refresh");
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 10_000 })
      .catch(() => {});
    await page
      .waitForSelector("div#search, div#rso", { timeout: 5_000 })
      .catch(() => {});
    
    try {
      await page.waitForSelector("div.g", { timeout: 1000 });
    } catch {
      if (DEBUG_LOG) console.log("[serp] optional retry wait timed out, proceeding");
    }
    
    results = await parseDomResults(page, requestCount);
    lastHtml = await page.content().catch(() => "");
  }

  // Detect if we're blocked
  const blocked =
    !results.length &&
    /captcha-form|recaptcha|unusual traffic|consent\.google/i.test(
      lastHtml || ""
    );

  if (DEBUG_LOG)
    console.log("[serp] parsed", { count: results.length, blocked });

  return { results: results.slice(0, count), blocked };
}
