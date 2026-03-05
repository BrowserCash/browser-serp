import { canonicalizeResultUrl } from './query.js';
import type {
  SearchResult,
  SerpAnswerBoxResult,
  SerpKnowledgeGraphResult,
  SerpOrganicResult,
  SerpPeopleAlsoAskResult,
  SerpRelatedSearchResult,
  SerpSitelink,
  SerpTopStoryResult,
} from './types.js';

export interface RawSerpSitelink {
  title: string;
  link: string;
}

export interface RawSearchResult {
  title: string;
  url: string;
  description: string;
  date?: string;
  sitelinks?: RawSerpSitelink[];
}

export interface RawPeopleAlsoAskResult {
  question: string;
  snippet?: string;
  title?: string;
  link?: string;
}

export interface RawRelatedSearchResult {
  query: string;
}

export interface RawTopStoryResult {
  title: string;
  link: string;
  source?: string;
  date?: string;
  imageUrl?: string;
}

export interface RawKnowledgeGraphResult {
  title?: string;
  type?: string;
  imageUrl?: string;
  description?: string;
  descriptionSource?: string;
  descriptionLink?: string;
  attributes?: Record<string, string>;
}

export interface RawAnswerBoxResult {
  title?: string;
  answer?: string;
  snippet?: string;
  source?: string;
  sourceLink?: string;
}

export interface RawSerpPayload {
  organic: RawSearchResult[];
  peopleAlsoAsk?: RawPeopleAlsoAskResult[];
  relatedSearches?: RawRelatedSearchResult[];
  topStories?: RawTopStoryResult[];
  knowledgeGraph?: RawKnowledgeGraphResult;
  answerBox?: RawAnswerBoxResult;
}

export interface NormalizedSerpPayload {
  organic: SerpOrganicResult[];
  peopleAlsoAsk?: SerpPeopleAlsoAskResult[];
  relatedSearches?: SerpRelatedSearchResult[];
  topStories?: SerpTopStoryResult[];
  knowledgeGraph?: SerpKnowledgeGraphResult;
  answerBox?: SerpAnswerBoxResult;
}

// Kept as a string for Runtime.evaluate execution in an isolated world.
export const DOM_SERP_PAYLOAD_SCRIPT = `(() => {
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  const toAbs = (href) => {
    if (!href) return '';
    try {
      return new URL(href, location.href).toString();
    } catch {
      return href;
    }
  };
  const pickFirstText = (root, selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (!node) continue;
      const text = clean(node.textContent || '');
      if (text) return text;
    }
    return '';
  };
  const pickFirstHref = (root, selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (!node) continue;
      const href = clean(node.getAttribute('href') || '');
      if (href) return toAbs(href);
    }
    return '';
  };
  const pickFirstImageSrc = (root, selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (!node) continue;
      const src = clean(node.getAttribute('src') || node.getAttribute('data-src') || '');
      if (!src) continue;
      if (src.startsWith('data:') || src.startsWith('blob:')) continue;
      return toAbs(src);
    }
    return '';
  };
  const isGoogleInternalSearchHref = (href) => {
    const absolute = toAbs(href);
    if (!absolute) return false;
    try {
      const parsed = new URL(absolute);
      const host = parsed.hostname.toLowerCase();
      if (!/(^|\\.)google\\./.test(host)) return false;
      return parsed.pathname === '/search' || parsed.pathname.startsWith('/search');
    } catch {
      return false;
    }
  };

  const organic = [];
  const seenOrganic = new Set();

  const addOrganic = (title, href, snippet, date, sitelinks) => {
    const t = clean(title);
    const h = clean(href);
    const s = clean(snippet);
    if (!t || !h) return;
    const lowerTitle = t.toLowerCase();
    if (
      lowerTitle === 'map' ||
      lowerTitle === 'people also ask' ||
      lowerTitle === 'recipes' ||
      lowerTitle === 'videos' ||
      lowerTitle === 'images' ||
      lowerTitle === 'news' ||
      lowerTitle === 'shopping' ||
      lowerTitle === 'discussions and forums'
    ) {
      return;
    }
    const lowerSnippet = s.toLowerCase();
    if (lowerSnippet === 'people also ask' || lowerSnippet === 'related searches') return;
    if (isGoogleInternalSearchHref(h)) return;
    const key = t + '||' + h;
    if (seenOrganic.has(key)) return;
    seenOrganic.add(key);

    const normalizedSitelinks = [];
    if (Array.isArray(sitelinks)) {
      const seenLinks = new Set();
      for (const item of sitelinks) {
        if (!item) continue;
        const st = clean(item.title);
        const sl = clean(item.link);
        if (!st || !sl || seenLinks.has(sl)) continue;
        if (st.length > 80) continue;
        seenLinks.add(sl);
        normalizedSitelinks.push({ title: st, link: sl });
        if (normalizedSitelinks.length >= 8) break;
      }
    }

    const entry = {
      title: t,
      url: toAbs(h),
      description: s,
    };
    if (date) entry.date = clean(date);
    if (normalizedSitelinks.length > 0) entry.sitelinks = normalizedSitelinks;
    organic.push(entry);
  };

  const blocks = [].concat(
    Array.from(document.querySelectorAll('div#search div.g')),
    Array.from(document.querySelectorAll('div#rso > div')),
    Array.from(document.querySelectorAll('div[data-sokoban-container] div.g')),
  );

  for (const block of blocks) {
    if (block.querySelector('div[jsname="N760b"], div.related-question-pair, div[jsname="Cpkphb"]')) {
      continue;
    }

    const titleEl = block.querySelector('h3');
    const linkEl = block.querySelector('a[href]');
    if (!titleEl || !linkEl) continue;

    const rawSnippetEl =
      block.querySelector('.VwiC3b, span.aCOpRe, div[role="text"], div.MUxGbd, div[data-sncf], div[data-snf]');
    let snippet = clean((rawSnippetEl && (rawSnippetEl.innerText || rawSnippetEl.textContent)) || '');
    let date = clean(
      (block.querySelector('span.MUxGbd.wuQ4Ob.WZ8Tjf, span.f') || { textContent: '' }).textContent || '',
    );

    if (!date && snippet) {
      const match = snippet.match(/^(\\d+\\s+(?:minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\\s+ago|[A-Z][a-z]{2}\\s+\\d{1,2},\\s+\\d{4})\\s*[·\\-]?\\s*(.*)$/);
      if (match) {
        date = clean(match[1]);
        snippet = clean(match[2]);
      }
    }

    const sitelinks = [];
    const mainHref = linkEl.getAttribute('href') || '';
    for (const anchor of Array.from(block.querySelectorAll('a[href]'))) {
      const href = anchor.getAttribute('href') || '';
      if (!href || href === mainHref) continue;
      const text = clean(anchor.textContent || '');
      if (!text || text.length < 2) continue;
      sitelinks.push({ title: text, link: toAbs(href) });
    }

    addOrganic(titleEl.textContent || '', mainHref, snippet, date, sitelinks);
    if (organic.length >= limit) break;
  }

  if (organic.length < limit) {
    const fallbackTitles = Array.from(document.querySelectorAll('div#search h3, div#rso h3, main h3'));
    for (const titleEl of fallbackTitles) {
      const linkEl = titleEl.closest('a[href]') || (titleEl.parentElement && titleEl.parentElement.querySelector('a[href]'));
      if (!linkEl) continue;
      const href = linkEl.getAttribute('href') || '';
      if (!href) continue;
      const block =
        titleEl.closest('div.g, div.MjjYud, div[data-sokoban-container], div[data-hveid], article') ||
        titleEl.parentElement ||
        document.body;
      const snippetEl =
        block.querySelector('.VwiC3b, span.aCOpRe, div[role="text"], div.MUxGbd, div[data-sncf], div[data-snf]');

      addOrganic(
        titleEl.textContent || '',
        href,
        (snippetEl && (snippetEl.innerText || snippetEl.textContent)) || '',
        '',
        [],
      );
      if (organic.length >= limit) break;
    }
  }

  const peopleAlsoAsk = [];
  const seenQuestions = new Set();
  const paaNodes = Array.from(
    document.querySelectorAll(
      'div[jsname="N760b"], div.related-question-pair, div[jsname="Cpkphb"], div[jscontroller="exgaYe"], div[jsname="yEVEwb"]',
    ),
  );
  for (const node of paaNodes) {
    const question = clean(
      (
        node.querySelector(
          'div[role="heading"], h3, h4, span[role="heading"], div[jsname="jIA8B"], div[jsname="Cpkphb"], button[aria-expanded] span, .CSkcDe',
        ) || { textContent: '' }
      ).textContent || '',
    );
    if (!question || seenQuestions.has(question)) continue;
    seenQuestions.add(question);

    const snippet = clean(
      (
        node.querySelector('.hgKElc, .yEVEwb, .IZ6rdc, div[data-sncf], div[data-snf], span[data-tts]') || {
          textContent: '',
        }
      ).textContent || '',
    );
    const linkEl = node.querySelector('a[href]');
    const title = clean((linkEl || { textContent: '' }).textContent || '');
    const link = clean((linkEl || { getAttribute: () => '' }).getAttribute('href') || '');

    const entry = { question };
    if (snippet) entry.snippet = snippet;
    if (title) entry.title = title;
    if (link) entry.link = toAbs(link);
    peopleAlsoAsk.push(entry);
    if (peopleAlsoAsk.length >= 10) break;
  }

  const relatedSearches = [];
  const seenRelated = new Set();
  const relatedNodes = Array.from(
    document.querySelectorAll('#bres a[href*="/search?"], #botstuff a[href*="/search?"], a[data-q][href*="/search?"]'),
  );
  for (const node of relatedNodes) {
    const query = clean(node.textContent || '');
    if (!query || query.length < 2 || seenRelated.has(query)) continue;
    if (query.toLowerCase() === 'related searches') continue;
    seenRelated.add(query);
    relatedSearches.push({ query });
    if (relatedSearches.length >= 12) break;
  }

  const topStories = [];
  const seenTopStory = new Set();
  const topStoryDateRegex = /(\\d+\\s+(?:minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\\s+ago|[A-Z][a-z]{2}\\s+\\d{1,2},\\s+\\d{4})/i;
  const topStoryContainers = Array.from(document.querySelectorAll('g-section-with-header, div[aria-label]'));
  for (const container of topStoryContainers) {
    const heading = clean((container.querySelector('h2, h3') || { textContent: '' }).textContent || '').toLowerCase();
    if (!heading.includes('top stories')) continue;

    for (const anchor of Array.from(container.querySelectorAll('a[href]'))) {
      const title = clean(
        (
          anchor.querySelector('div[role="heading"], h3, h4, span[role="heading"], div') ||
          { textContent: '' }
        ).textContent || '',
      );
      const href = clean(anchor.getAttribute('href') || '');
      if (!title || !href) continue;

      const key = title + '||' + href;
      if (seenTopStory.has(key)) continue;
      seenTopStory.add(key);

      const card = anchor.closest('g-card, article, div') || anchor;
      const source = clean((card.querySelector('cite, .MgUUmf, .CEMjEf') || { textContent: '' }).textContent || '');
      const date = clean((card.querySelector('span[data-timestamp], time, .OSrXXb') || { textContent: '' }).textContent || '');
      const imageUrl = clean((card.querySelector('img') || { getAttribute: () => '' }).getAttribute('src') || '');

      const entry = { title, link: toAbs(href) };
      if (source) entry.source = source;
      if (date) entry.date = date;
      if (imageUrl) entry.imageUrl = toAbs(imageUrl);
      topStories.push(entry);
      if (topStories.length >= 10) break;
    }
  }

  if (topStories.length === 0) {
    const cards = Array.from(document.querySelectorAll('g-card, div.SoaBEf, div[data-news-cluster]'));
    for (const card of cards) {
      const anchor = card.querySelector('a[href]');
      if (!anchor) continue;
      const title = clean(
        (
          card.querySelector('div[role="heading"], h3, h4, span[role="heading"]') ||
          { textContent: '' }
        ).textContent || '',
      );
      const href = clean(anchor.getAttribute('href') || '');
      if (!title || !href) continue;

      const text = clean(card.textContent || '');
      const dateMatch = text.match(topStoryDateRegex);
      const source = clean((card.querySelector('cite, .MgUUmf, .CEMjEf, .vr1PYe') || { textContent: '' }).textContent || '');
      const imageUrl = clean((card.querySelector('img[src]') || { getAttribute: () => '' }).getAttribute('src') || '');
      if (!dateMatch && !source) continue;

      const key = title + '||' + href;
      if (seenTopStory.has(key)) continue;
      seenTopStory.add(key);

      const entry = { title, link: toAbs(href) };
      if (source) entry.source = source;
      if (dateMatch && dateMatch[1]) entry.date = clean(dateMatch[1]);
      if (imageUrl) entry.imageUrl = toAbs(imageUrl);
      topStories.push(entry);
      if (topStories.length >= 10) break;
    }
  }

  const extractKgCandidate = (root) => {
    if (!root || typeof root.querySelector !== 'function') return null;

    const title = pickFirstText(root, [
      '[data-attrid="title"] span',
      '[data-attrid="title"]',
      'div.kp-header h2 span',
      '.qrShPb',
      'h2 span',
      'h2',
    ]);
    const lowerTitle = title.toLowerCase();
    if (!title || lowerTitle === 'complementary results' || lowerTitle === 'people also ask') return null;

    const type = pickFirstText(root, [
      '[data-attrid="subtitle"] span',
      '[data-attrid="subtitle"]',
      '.YhemCb',
      '.wwUB2c',
    ]);
    const description = pickFirstText(root, [
      '.kno-rdesc > span',
      '.kno-rdesc span',
      '.kno-rdesc',
      '[data-attrid="description"] span',
      '[data-attrid*="description"] span',
      '[data-attrid="kc:/common/topic/description"] span',
    ]);
    const descriptionSource = pickFirstText(root, [
      '.kno-rdesc a[href]',
      '[data-attrid="description"] a[href]',
      '[data-attrid*="description"] a[href]',
    ]);
    const descriptionLink = pickFirstHref(root, [
      '.kno-rdesc a[href]',
      '[data-attrid="description"] a[href]',
      '[data-attrid*="description"] a[href]',
    ]);
    const imageUrl = pickFirstImageSrc(root, [
      '.kp-wholepage img[src*="encrypted-tbn0.gstatic.com/images"]',
      '.kp-wholepage img[src*="gstatic.com/images"]',
      '.kp-wholepage img[src*="googleusercontent.com"]',
      '.kno-fb-ctx img[src]',
      '[data-attrid*="image"] img[src]',
      'img[src*="encrypted-tbn0.gstatic.com/images"]',
      'img[src*="gstatic.com/images"]',
      'img[src]',
    ]);

    const attributes = {};
    const attrNodes = Array.from(
      root.querySelectorAll(
        'div[data-attrid^="kc:/"], div[data-attrid*="kc:/"], div[data-attrid^="title"], div[data-attrid^="subtitle"], div[data-attrid]',
      ),
    );
    for (const node of attrNodes) {
      const text = clean(node.textContent || '');
      if (!text || !text.includes(':')) continue;
      const idx = text.indexOf(':');
      const key = clean(text.slice(0, idx));
      const value = clean(text.slice(idx + 1));
      if (!key || !value || attributes[key]) continue;
      if (/^\\d+$/.test(key)) continue;
      if (!/^[A-Za-z][A-Za-z0-9 '&().-]{1,64}$/.test(key)) continue;
      if (/^(about|profiles|people also search for|platforms|topics)$/i.test(key)) continue;
      attributes[key] = value;
    }

    const attrsSize = Object.keys(attributes).length;
    const hasCore = Boolean(type || description || imageUrl || attrsSize > 0);
    if (!hasCore) return null;

    const score =
      (title ? 3 : 0) +
      (description ? 3 : 0) +
      (imageUrl ? 2 : 0) +
      (type ? 1 : 0) +
      Math.min(3, attrsSize) +
      (descriptionSource && descriptionLink ? 1 : 0);

    const candidate = { title };
    if (type) candidate.type = type;
    if (imageUrl) candidate.imageUrl = toAbs(imageUrl);
    if (description) candidate.description = description;
    if (descriptionSource) candidate.descriptionSource = descriptionSource;
    if (descriptionLink) candidate.descriptionLink = toAbs(descriptionLink);
    if (attrsSize > 0) candidate.attributes = attributes;

    return { score, candidate };
  };

  let knowledgeGraph = null;
  const kgRoots = [];
  const seenKgRoots = new Set();
  const addKgRoot = (node) => {
    if (!node) return;
    if (seenKgRoots.has(node)) return;
    seenKgRoots.add(node);
    kgRoots.push(node);
  };

  addKgRoot(document.querySelector('#rhs'));
  for (const node of Array.from(document.querySelectorAll('.kp-wholepage, .knowledge-panel, [data-attrid="title"]'))) {
    addKgRoot(node.closest('#rhs, .kp-wholepage, .knowledge-panel') || node.parentElement || node);
  }

  let bestKg = null;
  for (const root of kgRoots) {
    const candidate = extractKgCandidate(root);
    if (!candidate) continue;
    if (!bestKg || candidate.score > bestKg.score) {
      bestKg = candidate;
    }
  }

  if (bestKg && bestKg.score >= 4) {
    knowledgeGraph = bestKg.candidate;
  }

  let answerBox = null;
  const weatherTemp = clean((document.querySelector('#wob_tm') || { textContent: '' }).textContent || '');
  if (weatherTemp) {
    const weatherTitle = clean((document.querySelector('#wob_loc') || { textContent: '' }).textContent || '');
    answerBox = {
      title: weatherTitle || 'Weather',
      answer: weatherTemp,
      source: 'Google Weather',
      sourceLink: 'https://support.google.com/websearch/answer/13687874',
    };
  }

  return {
    organic,
    peopleAlsoAsk,
    relatedSearches,
    topStories,
    knowledgeGraph,
    answerBox,
  };
})()`;

export function normalizeSearchResults(raw: RawSearchResult[], count: number): SearchResult[] {
  return normalizeOrganicResults(raw, count).map((entry) => ({
    title: entry.title,
    url: entry.link,
    description: entry.snippet,
    position: entry.position,
  }));
}

export function normalizeOrganicResults(raw: RawSearchResult[], count: number): SerpOrganicResult[] {
  const results: SerpOrganicResult[] = [];
  const seenUrls = new Set<string>();

  for (const entry of raw) {
    const title = (entry.title || '').trim();
    const snippet = (entry.description || '').trim();
    const canonical = canonicalizeResultUrl(entry.url);

    if (!title || !canonical) continue;
    if (isGoogleInternalSearchUrl(canonical)) continue;
    if (seenUrls.has(canonical)) continue;

    seenUrls.add(canonical);
    const result: SerpOrganicResult = {
      title,
      link: canonical,
      snippet,
      position: results.length + 1,
    };

    const date = (entry.date || '').trim();
    if (date) {
      result.date = date;
    }

    const sitelinks = normalizeSitelinks(entry.sitelinks, canonical);
    if (sitelinks.length > 0) {
      result.sitelinks = sitelinks;
    }

    results.push(result);

    if (results.length >= count) break;
  }

  return results;
}

export function normalizeSerpPayload(raw: RawSerpPayload, count: number): NormalizedSerpPayload {
  const organic = normalizeOrganicResults(raw.organic ?? [], count);

  const peopleAlsoAsk = normalizePeopleAlsoAsk(raw.peopleAlsoAsk ?? []);
  const relatedSearches = normalizeRelatedSearches(raw.relatedSearches ?? []);
  const topStories = normalizeTopStories(raw.topStories ?? []);
  const knowledgeGraph = enrichKnowledgeGraphFromOrganic(
    normalizeKnowledgeGraph(raw.knowledgeGraph),
    organic
  );
  const answerBox = normalizeAnswerBox(raw.answerBox);

  return {
    organic,
    ...(peopleAlsoAsk.length > 0 ? { peopleAlsoAsk } : {}),
    ...(relatedSearches.length > 0 ? { relatedSearches } : {}),
    ...(topStories.length > 0 ? { topStories } : {}),
    ...(knowledgeGraph ? { knowledgeGraph } : {}),
    ...(answerBox ? { answerBox } : {}),
  };
}

function enrichKnowledgeGraphFromOrganic(
  knowledgeGraph: SerpKnowledgeGraphResult | undefined,
  organic: SerpOrganicResult[]
): SerpKnowledgeGraphResult | undefined {
  if (!knowledgeGraph) return undefined;

  if (knowledgeGraph.description && knowledgeGraph.descriptionLink && knowledgeGraph.descriptionSource) {
    return knowledgeGraph;
  }

  const wiki = organic.find((entry) => entry.link.includes('wikipedia.org/wiki/'));
  if (!wiki) return knowledgeGraph;

  const enriched: SerpKnowledgeGraphResult = { ...knowledgeGraph };
  const snippet = wiki.snippet.trim();
  const looksLikeSummary = snippet.length >= 40 && !/wikipedia\s+https?:\/\//i.test(snippet);

  if (!enriched.description && looksLikeSummary) {
    enriched.description = snippet;
  }
  if (!enriched.descriptionLink) {
    enriched.descriptionLink = wiki.link;
  }
  if (!enriched.descriptionSource && enriched.descriptionLink?.includes('wikipedia.org')) {
    enriched.descriptionSource = 'Wikipedia';
  }

  return enriched;
}

function normalizeSitelinks(raw: RawSerpSitelink[] | undefined, parentLink?: string): SerpSitelink[] {
  if (!Array.isArray(raw)) return [];

  const out: SerpSitelink[] = [];
  const seen = new Set<string>();
  const canonicalParent = parentLink ? canonicalizeResultUrl(parentLink) : '';

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const title = String(entry.title || '').trim();
    const link = canonicalizeResultUrl(String(entry.link || ''));
    if (!title || !link || seen.has(link)) continue;
    if (link === canonicalParent) continue;
    if (isGoogleInternalSearchUrl(link)) continue;
    if (isGenericSitelinkTitle(title)) continue;
    seen.add(link);
    out.push({ title, link });
  }

  return out;
}

function isGenericSitelinkTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return true;
  if (/^read more\b/.test(normalized)) return true;
  if (/^more results from\b/.test(normalized)) return true;
  return false;
}

function normalizePeopleAlsoAsk(raw: RawPeopleAlsoAskResult[]): SerpPeopleAlsoAskResult[] {
  const out: SerpPeopleAlsoAskResult[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const question = String(entry?.question || '').trim();
    if (!question || seen.has(question)) continue;
    seen.add(question);

    const item: SerpPeopleAlsoAskResult = { question };
    const snippet = String(entry?.snippet || '').trim();
    const title = String(entry?.title || '').trim();
    const link = canonicalizeResultUrl(String(entry?.link || ''));
    if (snippet) item.snippet = snippet;
    if (title) item.title = title;
    if (link) item.link = link;
    out.push(item);
  }

  return out;
}

function normalizeRelatedSearches(raw: RawRelatedSearchResult[]): SerpRelatedSearchResult[] {
  const out: SerpRelatedSearchResult[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const query = String(entry?.query || '').trim();
    const lower = query.toLowerCase();
    if (!query || /^\d+$/.test(query)) continue;
    if (lower === 'previous' || lower === 'next') continue;
    if (!query || seen.has(query)) continue;
    seen.add(query);
    out.push({ query });
  }

  return out;
}

function normalizeTopStories(raw: RawTopStoryResult[]): SerpTopStoryResult[] {
  const out: SerpTopStoryResult[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const title = String(entry?.title || '').trim();
    const link = canonicalizeResultUrl(String(entry?.link || ''));
    if (!title || !link || seen.has(link)) continue;
    seen.add(link);

    const item: SerpTopStoryResult = {
      title,
      link,
    };

    const source = String(entry?.source || '').trim();
    const date = String(entry?.date || '').trim();
    const imageUrl = canonicalizeResultUrl(String(entry?.imageUrl || ''));

    if (source) item.source = source;
    if (date) item.date = date;
    if (imageUrl) item.imageUrl = imageUrl;
    out.push(item);
  }

  return out;
}

function normalizeKnowledgeGraph(raw: RawKnowledgeGraphResult | undefined): SerpKnowledgeGraphResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const title = String(raw.title || '').trim();
  const type = String(raw.type || '').trim();
  const imageUrl = canonicalizeResultUrl(String(raw.imageUrl || ''));
  const description = String(raw.description || '').trim();
  const descriptionSource = String(raw.descriptionSource || '').trim();
  const descriptionLink = canonicalizeResultUrl(String(raw.descriptionLink || ''));

  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.attributes || {})) {
    const normalizedKey = String(key || '').trim();
    const normalizedValue = String(value || '').trim();
    if (!normalizedKey || !normalizedValue) continue;
    if (/^\d+$/.test(normalizedKey)) continue;
    if (!/^[A-Za-z][A-Za-z0-9 '&().-]{1,64}$/.test(normalizedKey)) continue;
    attributes[normalizedKey] = normalizedValue;
  }

  if (!title && !type && !imageUrl && !description && !descriptionSource && !descriptionLink && Object.keys(attributes).length === 0) {
    return undefined;
  }

  return {
    ...(title ? { title } : {}),
    ...(type ? { type } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(description ? { description } : {}),
    ...(descriptionSource ? { descriptionSource } : {}),
    ...(descriptionLink ? { descriptionLink } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
  };
}

function isGoogleInternalSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)google\./.test(parsed.hostname.toLowerCase())) return false;
    return parsed.pathname === '/search' || parsed.pathname.startsWith('/search');
  } catch {
    return false;
  }
}

function normalizeAnswerBox(raw: RawAnswerBoxResult | undefined): SerpAnswerBoxResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const title = String(raw.title || '').trim();
  const answer = String(raw.answer || '').trim();
  const snippet = String(raw.snippet || '').trim();
  const source = String(raw.source || '').trim();
  const sourceLink = canonicalizeResultUrl(String(raw.sourceLink || ''));

  if (!title && !answer && !snippet && !source && !sourceLink) return undefined;

  return {
    ...(title ? { title } : {}),
    ...(answer ? { answer } : {}),
    ...(snippet ? { snippet } : {}),
    ...(source ? { source } : {}),
    ...(sourceLink ? { sourceLink } : {}),
  };
}

export function isLikelyChallengeHtml(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes('datadome') ||
    lower.includes('captcha') ||
    lower.includes('cf-challenge') ||
    lower.includes('just a moment') ||
    lower.includes('checking your browser') ||
    lower.includes('press & hold')
  );
}
