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

      if (!response) {
        if (DEBUG_LOG) log("[serp] navigation failed for", tag);
        return { results: [], html: "", stepTimings: [] };
      }

      markStep(`${tag}_navigation`);

      let html = "";

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
    if (!results.length) {
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
      lastHtml = ""

      timing.mark("refresh_parse_dom");
    }

    // Pagination: Fetch more pages by clicking "Next" if we haven't met the requested count
    let pageNum = 1;
    const MAX_PAGES = 5;
    while (results.length < count && pageNum < MAX_PAGES) {
      try {
        if (true) {
          if (DEBUG_LOG)
            log(
              `[serp] clicking next page (current: ${results.length}, target: ${count})`
            );

          const currentURL = page.url();
          console.time("click_next");
          const newDestUrl = new URL(currentURL);
          newDestUrl.searchParams.set("start", (pageNum * 10).toString());
          await page.evaluate((url: string) => {
            window.location.href = url;
          }, newDestUrl.toString());
          console.timeEnd("click_next");

          let changed = false;

          while (page.url() === currentURL) {
            await page.waitForTimeout(10);
          }
          changed = true;

          if (DEBUG_LOG) log("[serp] pagination detected change:", changed);

          // Optimistic parse - no wait if changed detected
          let newResults = await parseDomResults(page, requestCount);

          // Smart Retry: If no new results (race condition), wait briefly and retry once
          let newUnique = 0;
          for (const r of newResults) {
            if (!results.find((x) => x.url === r.url)) newUnique++;
          }

          if (DEBUG_LOG) log("[serp] pagination new unique results:", newUnique);

          if (newUnique === 0 && changed) {
            if (DEBUG_LOG)
              log(
                "[serp] pagination changed but no new results, retrying parse"
              );
            await page.waitForTimeout(500);
            newResults = await parseDomResults(page, requestCount);
          } else if (newUnique === 0 && !changed) {
            // Fail fast to avoid infinite loop
            if (DEBUG_LOG)
              log("[serp] pagination failed to change content, stopping");
            break;
          }

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

    const blocked = !results.length;

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
