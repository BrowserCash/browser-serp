import { SearchParams, SearchResult } from "./types.js";
import { parseDomResults } from "./extractor.js";
import path from "node:path";
import fs from "node:fs";

const DEBUG_HTML =
  process.env.SERP_DEBUG_HTML === "1" || process.env.SERP_DEBUG_HTML === "true";
const DEBUG_LOG =
  process.env.SERP_DEBUG_LOG === "1" || process.env.SERP_DEBUG_LOG === "true";

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

  print(label: string, logFn?: (line: string) => void): void {
    const totalMs = this.getTotalMs();
    const out = logFn ?? ((s: string) => console.log(s));
    out(`[serp-timing] ${label} - Total: ${totalMs}ms`);
    out(`[serp-timing] Step breakdown:`);
    for (const { step, durationMs } of this.steps) {
      out(`  - ${step}: ${durationMs}ms`);
    }
  }
}

function dumpHtml(html: string, label: string): void {
  if (!DEBUG_HTML) return;

  try {
    const outPath = path.join(process.cwd(), `serp-debug-${label}.html`);
    fs.writeFileSync(outPath, html, "utf8");
    if (DEBUG_LOG) console.log(`[serp-debug] wrote ${outPath}`);
  } catch (err) {
    if (DEBUG_LOG) console.error("[serp-debug] failed to write html dump", err);
  }
}

export async function runGoogleSearch(
  page: any,
  params: SearchParams
): Promise<{ results: SearchResult[]; blocked: boolean }> {
  const timing = new TimingTracker();
  const t0 = Date.now();
  const log = (...args: any[]) => {
    if (!DEBUG_LOG) return;
    const elapsed = Date.now() - t0;
    if (args.length > 0 && typeof args[0] === "string") {
      console.log(`[+${elapsed}ms] ${args[0]}`, ...args.slice(1));
    } else {
      console.log(`[+${elapsed}ms]`, ...args);
    }
  };
  // Attach page-level event logging to diagnose drops (guarded by DEBUG_LOG)
  let attached = false;
  const onClose = () => log("[page] close event");
  const onCrash = () => log("[page] crash event");
  try {
    if (DEBUG_LOG && typeof page?.on === "function") {
      page.on("close", onClose);
      page.on("crash", onCrash);
      attached = true;
    }

    const count = Math.min(Math.max(params.count ?? 10, 1), 100);
    // Request slightly more results than needed to account for non-standard result types that might be filtered
    const requestCount = Math.min(count + 5, 100);
    const hl = params.search_lang || "en";
    const gl = params.country?.toLowerCase();
    const query = encodeURIComponent(params.q);
    // Use standard Google search URL - gbv=1 (basic HTML) was actually slower
    const baseUrl = `https://www.google.com/search?q=${query}&num=${requestCount}&hl=${encodeURIComponent(
      hl
    )}${gl ? `&gl=${encodeURIComponent(gl)}` : ""}&safe=off`;

    timing.mark("build_url");

    if (DEBUG_LOG)
      log("[serp] searching", { q: params.q, count, requestCount });

    try {
      await page
        .context()
        .setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    } catch (err) {
      if (DEBUG_LOG) log("[serp] failed to set headers", err);
    }

    timing.mark("set_headers");

    const fetchAndParse = async (
      url: string,
      tag: string
    ): Promise<{
      results: SearchResult[];
      html: string;
      stepTimings: StepTiming[];
    }> => {
      const stepTimings: StepTiming[] = [];
      let lastTime = Date.now();

      const markStep = (step: string) => {
        const now = Date.now();
        const durationMs = now - lastTime;
        stepTimings.push({ step, durationMs });
        if (DEBUG_LOG) log(`[serp-timing] ${step}: ${durationMs}ms`);
        lastTime = now;
      };

      // Navigate and wait for full page load (including JS rendering of results)
      const response = await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 })
        .catch(() => null);

      markStep(`${tag}_navigation`);

      // Check if navigation succeeded
      if (!response) {
        if (DEBUG_LOG) log("[serp] navigation failed for", tag);
        return { results: [], html: "", stepTimings: [] };
      }

      // Ensure search container exists before parsing (crucial for domcontentloaded)
      try {
        await page.waitForSelector("div#search, div#rso", { timeout: 2_000 });
      } catch {}

      const html = await page.content().catch(() => "");
      if (html) dumpHtml(html, tag);

      markStep(`${tag}_get_content`);

      const results = await parseDomResults(page, requestCount);

      markStep(`${tag}_parse_dom`);

      return { results, html, stepTimings };
    };

    // Fetch and parse Google search results
    let {
      results,
      html: lastHtml,
      stepTimings,
    } = await fetchAndParse(baseUrl, "google-search");

    // Add fetch timings to main tracker
    timing.mergeSteps(stepTimings);

    // If still empty, try one more time with a page refresh
    // This helps if the page loaded but scripts failed or content was dynamically blocked temporarily
    if (!results.length && lastHtml) {
      if (DEBUG_LOG) log("[serp] trying page refresh");
      timing.mark("refresh_start");

      await page
        .reload({ waitUntil: "domcontentloaded", timeout: 4_000 })
        .catch(() => {});

      timing.mark("refresh_reload");

      await page
        .waitForSelector("div#search, div#rso", { timeout: 2_000 })
        .catch(() => {});

      timing.mark("refresh_wait_container");

      try {
        await page.waitForSelector("div.g", { timeout: 500 });
      } catch {
        if (DEBUG_LOG) log("[serp] optional retry wait timed out, proceeding");
      }

      timing.mark("refresh_wait_results");

      results = await parseDomResults(page, requestCount);
      lastHtml = await page.content().catch(() => "");

      timing.mark("refresh_parse_dom");
    }

    // Pagination: Fetch more pages by clicking "Next" if we haven't met the requested count
    let pageNum = 1;
    const MAX_PAGES = 5;
    while (results.length < count && pageNum < MAX_PAGES) {
      const currentHtml = await page.content().catch(() => "");
      if (
        /captcha-form|recaptcha|unusual traffic|consent\.google/i.test(
          currentHtml
        )
      )
        break;

      try {
        // Scroll to bottom to ensure footer/next button is ready
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight)
        );
        await page.waitForTimeout(200);

        const nextBtn = page
          .locator('a#pnnext, a[aria-label="Next page"], a:has-text("Next")')
          .first();
        if (await nextBtn.isVisible({ timeout: 1500 })) {
          if (DEBUG_LOG)
            log(
              `[serp] clicking next page (current: ${results.length}, target: ${count})`
            );

          await Promise.all([
            nextBtn.click(),
            page
              .waitForLoadState("domcontentloaded", { timeout: 6_000 })
              .catch(() => {}),
          ]);

          const newResults = await parseDomResults(page, requestCount);
          for (const r of newResults) {
            if (!results.find((x) => x.url === r.url)) results.push(r);
          }
          pageNum++;
        } else {
          break;
        }
      } catch (err) {
        if (DEBUG_LOG) log("[serp] pagination error", err);
        break;
      }
    }

    // Detect if we're blocked
    const blocked =
      !results.length &&
      /captcha-form|recaptcha|unusual traffic|consent\.google/i.test(
        lastHtml || ""
      );

    timing.mark("detect_blocked");

    if (DEBUG_LOG) {
      log("[serp] parsed", { count: results.length, blocked });
      timing.print(`search q="${params.q}"`, (line) => log(line));
    }

    return { results: results.slice(0, count), blocked };
  } finally {
    // Cleanup listeners
    try {
      if (attached && typeof page?.off === "function") {
        page.off("close", onClose);
        page.off("crash", onCrash);
      }
    } catch {}
  }
}
