import { CDPClient } from '../cdp.js';
import { resolveWsUrl } from '../cdp-resolve.js';
import type { CDPClientLike, WarmCDPContext } from '../pool/types.js';
import {
  DOM_SERP_PAYLOAD_SCRIPT,
  isLikelyChallengeHtml,
  normalizeSerpPayload,
  type RawSearchResult,
  type RawSerpPayload,
} from './extractor.js';
import { buildGoogleSearchUrl, clampCount } from './query.js';
import type { CdpInput, SearchExecutionConfig, SearchExecutionResult, SearchParams } from './types.js';

const DEFAULT_CONFIG: SearchExecutionConfig = {
  timeoutMs: 15_000,
  networkIdleMs: 0,
  stabilityPollMs: 60,
  stabilityChecks: 1,
  minContentLength: 128,
};

const FINGERPRINT_EXPRESSION = `(() => {
  const h = document.documentElement;
  const b = document.body;
  if (!h || !b) return '0||0|0|0';
  const n = document.readyState === 'complete' ? 2 : document.readyState === 'interactive' ? 1 : 0;
  const c = document.querySelector('iframe[src*="captcha-delivery.com"],iframe[src*="challenges.cloudflare.com"],#challenge-running,#cf-challenge-running,#px-captcha,.px-captcha') !== null ? 1 : 0;
  const r = document.querySelectorAll('div#search h3, div#rso h3, main h3').length;
  const contentLength = h.innerHTML.length;
  return contentLength + '|' + document.title + '|' + n + '|' + c + '|' + r;
})()`;

const SEARCH_MAX_PAGES = 5;
const RICH_ENRICH_MAX_WAIT_MS = 80;
const RICH_ENRICH_POLL_MS = 40;

interface NavigateResult {
  statusCode: number;
  navigations: number;
  frameId: string;
}

interface Fingerprint {
  contentLength: number;
  title: string;
  elementCount: number;
  challenge: boolean;
  resultCount: number;
}

export async function runGoogleSearch(
  cdpInput: CdpInput,
  params: SearchParams,
  config: Partial<SearchExecutionConfig> = {}
): Promise<SearchExecutionResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (typeof cdpInput === 'string') {
    return runCold(cdpInput, params, cfg);
  }

  return runWarm(cdpInput, params, cfg);
}

async function runWarm(
  warm: WarmCDPContext,
  params: SearchParams,
  cfg: SearchExecutionConfig
): Promise<SearchExecutionResult> {
  if (warm.client.closed) {
    throw new Error('Warm CDP connection is closed');
  }

  const start = Date.now();
  const sequence = await runSearchSequence(warm.client, warm.cdpSessionId, params, cfg);
  return {
    ...sequence,
    totalTimeMs: Date.now() - start,
  };
}

async function runCold(
  cdpUrl: string,
  params: SearchParams,
  cfg: SearchExecutionConfig
): Promise<SearchExecutionResult> {
  const start = Date.now();
  const wsUrl = await resolveWsUrl(cdpUrl);
  const client = await CDPClient.connect(wsUrl, 12_000);

  let sessionId: string | undefined;
  let targetId: string | undefined;

  try {
    if (!isPageUrl(wsUrl)) {
      const targetsResult = await client.send('Target.getTargets');
      const targets = targetsResult.targetInfos as Array<{ targetId: string; type: string }>;
      const page = targets.find((t) => t.type === 'page');

      if (page) {
        targetId = page.targetId;
      } else {
        const createResult = await client.send('Target.createTarget', { url: 'about:blank' });
        targetId = createResult.targetId as string;
      }

      const attachResult = await client.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      sessionId = attachResult.sessionId as string;
    }

    await Promise.all([
      client.send('Page.enable', undefined, sessionId),
      client.send('Network.enable', undefined, sessionId),
      client.send('Runtime.enable', undefined, sessionId),
    ]);

    const sequence = await runSearchSequence(client, sessionId, params, cfg);
    return {
      ...sequence,
      totalTimeMs: Date.now() - start,
    };
  } finally {
    client.close();
  }
}

async function runSearchSequence(
  client: CDPClientLike,
  sessionId: string | undefined,
  params: SearchParams,
  cfg: SearchExecutionConfig
): Promise<Omit<SearchExecutionResult, 'totalTimeMs'>> {
  const requestedCount = clampCount(params.count);
  const requestCount = clampCount(params.num ?? (requestedCount <= 10 ? 10 : Math.min(Math.max(requestedCount + 5, requestedCount), 100)));
  const maxPages = Math.max(
    1,
    Math.min(
      Math.floor(params.maxPages ?? (requestedCount <= 10 ? 1 : requestedCount <= 20 ? 2 : SEARCH_MAX_PAGES)),
      SEARCH_MAX_PAGES
    )
  );
  const fastResultThreshold = Math.max(3, Math.min(6, requestedCount));
  const firstPageEnoughThreshold = Math.max(6, Math.min(9, requestedCount));
  const allowFastFinish = true;
  const sequenceStartedAt = Date.now();

  let statusCode = 0;
  let navigations = 0;
  let finalUrl = buildGoogleSearchUrl(params, 0, requestCount);
  const mergedRawResults: RawSearchResult[] = [];
  let pagePayload: RawSerpPayload | null = null;

  for (let page = 0; page < maxPages && mergedRawResults.length < requestedCount; page++) {
    if (cfg.abortSignal?.aborted) break;

    const startOffset = page * 10;
    const url = buildGoogleSearchUrl(params, startOffset, requestCount);
    const wait = await navigateAndWait(
      client,
      url,
      sessionId,
      cfg,
      sequenceStartedAt,
      fastResultThreshold,
      allowFastFinish
    );
    statusCode = wait.statusCode || statusCode;
    navigations += wait.navigations;

    const contextId = await createExtractWorld(client, sessionId, wait.frameId);

    let payload = await evaluateSerpPayload(client, sessionId, contextId, requestCount);
    if (page === 0 && params.featureRich && shouldEnrichRichSections(payload) && !cfg.abortSignal?.aborted) {
      payload = await enrichRichSections(client, sessionId, contextId, requestCount, payload, cfg.abortSignal);
    }
    pagePayload = payload;
    for (const entry of payload.organic) {
      mergedRawResults.push(entry);
    }

    const pageUrl = await evaluateString(client, sessionId, contextId, 'document.location.href');
    if (pageUrl) {
      finalUrl = pageUrl;
    }

    if (payload.organic.length === 0 && page > 0) {
      break;
    }

    if (page === 0) {
      const firstPagePayload = normalizeSerpPayload(
        {
          organic: mergedRawResults,
        },
        requestedCount
      );
      if (firstPagePayload.organic.length >= firstPageEnoughThreshold) {
        break;
      }
    }
  }

  const normalized = normalizeSerpPayload(
    {
      organic: mergedRawResults,
      peopleAlsoAsk: pagePayload?.peopleAlsoAsk,
      relatedSearches: pagePayload?.relatedSearches,
      topStories: pagePayload?.topStories,
      knowledgeGraph: pagePayload?.knowledgeGraph,
      answerBox: pagePayload?.answerBox,
    },
    requestedCount
  );
  const blocked = normalized.organic.length === 0;

  if (!blocked) {
    const results = normalized.organic.map((entry, index) => ({
      title: entry.title,
      url: entry.link,
      description: entry.snippet,
      position: index + 1,
    }));

    return {
      results,
      organic: normalized.organic,
      peopleAlsoAsk: normalized.peopleAlsoAsk,
      relatedSearches: normalized.relatedSearches,
      topStories: normalized.topStories,
      knowledgeGraph: normalized.knowledgeGraph,
      answerBox: normalized.answerBox,
      blocked: false,
      finalUrl,
      statusCode,
      navigations,
    };
  }

  // Last fallback: inspect raw HTML for challenge signatures.
  try {
    const tree = await client.send('Page.getFrameTree', undefined, sessionId);
    const frame = (tree.frameTree as Record<string, unknown>)?.frame as Record<string, unknown> | undefined;
    const frameId = (frame?.id as string) || '';
    if (frameId) {
      const contextId = await createExtractWorld(client, sessionId, frameId);
      const html = await evaluateString(client, sessionId, contextId, 'document.documentElement.outerHTML');
      if (isLikelyChallengeHtml(html)) {
        return {
          results: [],
          organic: [],
          blocked: true,
          finalUrl,
          statusCode,
          navigations,
        };
      }
    }
  } catch {
    // Ignore fallback checks.
  }

  return {
    results: [],
    organic: [],
    blocked: true,
    finalUrl,
    statusCode,
    navigations,
  };
}

async function evaluateSerpPayload(
  client: CDPClientLike,
  sessionId: string | undefined,
  contextId: number,
  limit: number
): Promise<RawSerpPayload> {
  const expression = `(() => { const limit = ${Math.max(1, Math.min(limit, 100))}; return ${DOM_SERP_PAYLOAD_SCRIPT}; })()`;
  const result = await client.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      contextId,
    },
    sessionId
  );

  const value = (result.result as Record<string, unknown>)?.value as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object') {
    return { organic: [] };
  }

  return {
    organic: parseRawOrganic(value.organic),
    peopleAlsoAsk: parseRawPeopleAlsoAsk(value.peopleAlsoAsk),
    relatedSearches: parseRawRelatedSearches(value.relatedSearches),
    topStories: parseRawTopStories(value.topStories),
    knowledgeGraph: parseRawKnowledgeGraph(value.knowledgeGraph),
    answerBox: parseRawAnswerBox(value.answerBox),
  };
}

function shouldEnrichRichSections(payload: RawSerpPayload): boolean {
  if ((payload.organic?.length ?? 0) === 0) return false;
  if (!hasRichSections(payload)) return true;

  const kg = payload.knowledgeGraph;
  if (kg) {
    const missingCoreDetails = !kg.description || !kg.descriptionLink || !kg.imageUrl;
    if (missingCoreDetails) return true;
  }

  return false;
}

function hasRichSections(payload: RawSerpPayload): boolean {
  return Boolean(
    payload.answerBox ||
      payload.knowledgeGraph ||
      (payload.topStories && payload.topStories.length > 0) ||
      (payload.peopleAlsoAsk && payload.peopleAlsoAsk.length > 0) ||
      (payload.relatedSearches && payload.relatedSearches.length > 0)
  );
}

async function enrichRichSections(
  client: CDPClientLike,
  sessionId: string | undefined,
  contextId: number,
  limit: number,
  initial: RawSerpPayload,
  abortSignal?: { aborted: boolean }
): Promise<RawSerpPayload> {
  const deadline = Date.now() + RICH_ENRICH_MAX_WAIT_MS;
  let best = initial;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(RICH_ENRICH_POLL_MS, remaining));
    if (abortSignal?.aborted) break;

    try {
      const next = await evaluateSerpPayload(client, sessionId, contextId, limit);
      best = mergeRichPayload(best, next);
      if (hasRichSections(best)) break;
    } catch {
      break;
    }
  }

  return best;
}

function mergeRichPayload(base: RawSerpPayload, next: RawSerpPayload): RawSerpPayload {
  return {
    organic: next.organic.length > base.organic.length ? next.organic : base.organic,
    peopleAlsoAsk:
      next.peopleAlsoAsk && next.peopleAlsoAsk.length > 0
        ? next.peopleAlsoAsk
        : base.peopleAlsoAsk,
    relatedSearches:
      next.relatedSearches && next.relatedSearches.length > 0
        ? next.relatedSearches
        : base.relatedSearches,
    topStories:
      next.topStories && next.topStories.length > 0
        ? next.topStories
        : base.topStories,
    knowledgeGraph: mergeKnowledgeGraph(base.knowledgeGraph, next.knowledgeGraph),
    answerBox: next.answerBox || base.answerBox,
  };
}

function mergeKnowledgeGraph(
  base: RawSerpPayload['knowledgeGraph'],
  next: RawSerpPayload['knowledgeGraph']
): RawSerpPayload['knowledgeGraph'] {
  if (!base) return next;
  if (!next) return base;

  return {
    title: next.title || base.title,
    type: next.type || base.type,
    imageUrl: next.imageUrl || base.imageUrl,
    description: next.description || base.description,
    descriptionSource: next.descriptionSource || base.descriptionSource,
    descriptionLink: next.descriptionLink || base.descriptionLink,
    attributes: {
      ...(base.attributes || {}),
      ...(next.attributes || {}),
    },
  };
}

function parseRawOrganic(value: unknown): RawSearchResult[] {
  if (!Array.isArray(value)) return [];
  const out: RawSearchResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;

    const sitelinks: { title: string; link: string }[] = [];
    if (Array.isArray(r.sitelinks)) {
      for (const item of r.sitelinks) {
        if (!item || typeof item !== 'object') continue;
        const sl = item as Record<string, unknown>;
        sitelinks.push({
          title: String(sl.title ?? ''),
          link: String(sl.link ?? ''),
        });
      }
    }

    out.push({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      description: String(r.description ?? ''),
      date: typeof r.date === 'string' ? r.date : undefined,
      sitelinks: sitelinks.length > 0 ? sitelinks : undefined,
    });
  }
  return out;
}

function parseRawPeopleAlsoAsk(value: unknown): RawSerpPayload['peopleAlsoAsk'] {
  if (!Array.isArray(value)) return undefined;
  const parsed: NonNullable<RawSerpPayload['peopleAlsoAsk']> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    parsed.push({
      question: String(r.question ?? ''),
      snippet: typeof r.snippet === 'string' ? r.snippet : undefined,
      title: typeof r.title === 'string' ? r.title : undefined,
      link: typeof r.link === 'string' ? r.link : undefined,
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

function parseRawRelatedSearches(value: unknown): RawSerpPayload['relatedSearches'] {
  if (!Array.isArray(value)) return undefined;
  const parsed: NonNullable<RawSerpPayload['relatedSearches']> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    parsed.push({
      query: String(r.query ?? ''),
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

function parseRawTopStories(value: unknown): RawSerpPayload['topStories'] {
  if (!Array.isArray(value)) return undefined;
  const parsed: NonNullable<RawSerpPayload['topStories']> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    parsed.push({
      title: String(r.title ?? ''),
      link: String(r.link ?? ''),
      source: typeof r.source === 'string' ? r.source : undefined,
      date: typeof r.date === 'string' ? r.date : undefined,
      imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : undefined,
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

function parseRawKnowledgeGraph(value: unknown): RawSerpPayload['knowledgeGraph'] {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const attributes: Record<string, string> = {};
  if (r.attributes && typeof r.attributes === 'object') {
    for (const [key, rawValue] of Object.entries(r.attributes as Record<string, unknown>)) {
      attributes[key] = String(rawValue ?? '');
    }
  }

  return {
    title: typeof r.title === 'string' ? r.title : undefined,
    type: typeof r.type === 'string' ? r.type : undefined,
    imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : undefined,
    description: typeof r.description === 'string' ? r.description : undefined,
    descriptionSource: typeof r.descriptionSource === 'string' ? r.descriptionSource : undefined,
    descriptionLink: typeof r.descriptionLink === 'string' ? r.descriptionLink : undefined,
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
  };
}

function parseRawAnswerBox(value: unknown): RawSerpPayload['answerBox'] {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  return {
    title: typeof r.title === 'string' ? r.title : undefined,
    answer: typeof r.answer === 'string' ? r.answer : undefined,
    snippet: typeof r.snippet === 'string' ? r.snippet : undefined,
    source: typeof r.source === 'string' ? r.source : undefined,
    sourceLink: typeof r.sourceLink === 'string' ? r.sourceLink : undefined,
  };
}

async function evaluateString(
  client: CDPClientLike,
  sessionId: string | undefined,
  contextId: number,
  expression: string
): Promise<string> {
  const result = await client.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      contextId,
    },
    sessionId
  );

  return String((result.result as Record<string, unknown>)?.value ?? '');
}

function isPageUrl(wsUrl: string): boolean {
  return wsUrl.includes('/devtools/page/');
}

async function createExtractWorld(
  client: CDPClientLike,
  sessionId: string | undefined,
  frameId: string
): Promise<number> {
  try {
    const result = await client.send(
      'Page.createIsolatedWorld',
      { frameId, worldName: 'browser_serp_extract' },
      sessionId
    );
    return result.executionContextId as number;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('-32602') && !message.includes('No frame')) {
      throw err;
    }

    const tree = await client.send('Page.getFrameTree', undefined, sessionId);
    const frame = (tree.frameTree as Record<string, unknown>)?.frame as Record<string, unknown> | undefined;
    const freshId = frame?.id as string | undefined;
    if (!freshId) {
      throw err;
    }

    const retried = await client.send(
      'Page.createIsolatedWorld',
      { frameId: freshId, worldName: 'browser_serp_extract' },
      sessionId
    );
    return retried.executionContextId as number;
  }
}

function navigateAndWait(
  client: CDPClientLike,
  url: string,
  sessionId: string | undefined,
  cfg: SearchExecutionConfig,
  startTime: number,
  fastResultThreshold: number,
  allowFastFinish: boolean
): Promise<NavigateResult> {
  return new Promise<NavigateResult>((resolve, reject) => {
    type State = 'NAVIGATING' | 'LOADING' | 'SETTLING' | 'DONE';
    let state: State = 'NAVIGATING';
    let navigations = 0;
    let statusCode = 0;
    let currentFrameId = '';

    let lastFingerprint: Fingerprint | null = null;
    let stableCount = 0;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutMs = Math.max(0, cfg.timeoutMs - (Date.now() - startTime));
    const timeout = setTimeout(() => finish(), timeoutMs);
    const abortTimer = cfg.abortSignal
      ? setInterval(() => {
          if (cfg.abortSignal?.aborted) finish();
        }, 100)
      : null;

    function cleanup() {
      clearTimeout(timeout);
      if (abortTimer) clearInterval(abortTimer);
      if (pollTimer) clearTimeout(pollTimer);
      client.off('Page.frameNavigated', onFrameNavigated);
      client.off('Page.domContentEventFired', onDomContentLoaded);
      client.off('Page.loadEventFired', onLoadEventFired);
      client.off('Network.responseReceived', onResponseReceived);
      client.off('Page.navigatedWithinDocument', onSoftNavigation);
    }

    function finish() {
      if (state === 'DONE') return;
      state = 'DONE';
      cleanup();
      resolve({ statusCode, navigations, frameId: currentFrameId });
    }

    async function pollStability() {
      if (state !== 'SETTLING') return;
      if (cfg.abortSignal?.aborted) {
        finish();
        return;
      }

      try {
        const result = await client.send(
          'Runtime.evaluate',
          {
            expression: FINGERPRINT_EXPRESSION,
            returnByValue: true,
          },
          sessionId
        );

        const fingerprint = parseFingerprint(String((result.result as Record<string, unknown>)?.value ?? '0||0|0|0'));

        if (
          allowFastFinish &&
          !fingerprint.challenge &&
          fingerprint.contentLength >= cfg.minContentLength &&
          fingerprint.resultCount >= fastResultThreshold
        ) {
          finish();
          return;
        }

        const stable =
          lastFingerprint !== null &&
          fingerprint.title === lastFingerprint.title &&
          fingerprint.challenge === lastFingerprint.challenge &&
          fingerprint.contentLength === lastFingerprint.contentLength &&
          fingerprint.elementCount === lastFingerprint.elementCount &&
          fingerprint.resultCount === lastFingerprint.resultCount;

        if (
          stable &&
          fingerprint.contentLength >= cfg.minContentLength &&
          (fingerprint.resultCount > 0 || fingerprint.challenge)
        ) {
          stableCount += 1;
          if (stableCount >= cfg.stabilityChecks) {
            finish();
            return;
          }
        } else {
          stableCount = 0;
          lastFingerprint = fingerprint;
        }
      } catch {
        stableCount = 0;
      }

      if (state === 'SETTLING') {
        pollTimer = setTimeout(() => {
          pollTimer = null;
          void pollStability();
        }, cfg.stabilityPollMs);
      }
    }

    function startPolling() {
      if (pollTimer || state !== 'SETTLING') return;
      if (cfg.networkIdleMs <= 0) {
        void pollStability();
        return;
      }

      pollTimer = setTimeout(() => {
        pollTimer = null;
        void pollStability();
      }, cfg.networkIdleMs);
    }

    function onFrameNavigated(params: Record<string, unknown>) {
      const frame = params?.frame as Record<string, unknown> | undefined;
      if (!frame || frame.parentId) return;
      navigations += 1;
      currentFrameId = (frame.id as string) || currentFrameId;
      stableCount = 0;
      lastFingerprint = null;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      state = 'LOADING';
    }

    function onDomContentLoaded() {
      if (state === 'LOADING' || state === 'NAVIGATING') {
        state = 'SETTLING';
        startPolling();
      }
    }

    function onLoadEventFired() {
      if (state === 'LOADING' || state === 'NAVIGATING') {
        state = 'SETTLING';
        startPolling();
      }
    }

    function onResponseReceived(params: Record<string, unknown>) {
      if ((params?.type as string) !== 'Document') return;
      const response = params?.response as Record<string, unknown> | undefined;
      if (response && typeof response.status === 'number') {
        statusCode = response.status;
      }
    }

    function onSoftNavigation() {
      stableCount = 0;
      lastFingerprint = null;
    }

    client.on('Page.frameNavigated', onFrameNavigated);
    client.on('Page.domContentEventFired', onDomContentLoaded);
    client.on('Page.loadEventFired', onLoadEventFired);
    client.on('Network.responseReceived', onResponseReceived);
    client.on('Page.navigatedWithinDocument', onSoftNavigation);

    try {
      client.send('Page.navigate', { url }, sessionId).catch((err) => {
        cleanup();
        reject(new Error(`Navigation failed: ${err instanceof Error ? err.message : String(err)}`));
      });
    } catch (err) {
      cleanup();
      reject(new Error(`Navigation failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFingerprint(raw: string): Fingerprint {
  const last = raw.lastIndexOf('|');
  const resultCount = parseInt(last >= 0 ? raw.slice(last + 1) : '0', 10) || 0;
  const beforeResults = last >= 0 ? raw.slice(0, last) : raw;

  const challengeIdx = beforeResults.lastIndexOf('|');
  const challenge = (challengeIdx >= 0 ? beforeResults.slice(challengeIdx + 1) : '0') === '1';
  const beforeChallenge = challengeIdx >= 0 ? beforeResults.slice(0, challengeIdx) : beforeResults;

  const elementIdx = beforeChallenge.lastIndexOf('|');
  const elementCount = parseInt(elementIdx >= 0 ? beforeChallenge.slice(elementIdx + 1) : '0', 10) || 0;
  const beforeElements = elementIdx >= 0 ? beforeChallenge.slice(0, elementIdx) : beforeChallenge;

  const first = beforeElements.indexOf('|');
  const contentLength = parseInt(first >= 0 ? beforeElements.slice(0, first) : beforeElements, 10) || 0;
  const title = first >= 0 ? beforeElements.slice(first + 1) : '';

  return {
    contentLength,
    title,
    elementCount,
    challenge,
    resultCount,
  };
}
