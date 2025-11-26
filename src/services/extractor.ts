import { SearchResult } from './types.js';

/**
 * DOM extraction script - kept as string to avoid tsx transpilation issues
 */
const DOM_EXTRACTOR_SCRIPT = `
  var uniq = new Set();
  var candidates = [].concat(
    Array.from(document.querySelectorAll('div#search div.g')),
    Array.from(document.querySelectorAll('div#search div[data-header-feature="0"]')),
    Array.from(document.querySelectorAll('div#rso > div'))
  );
  candidates.forEach(function(el) { uniq.add(el); });

  var clean = function(text) { return (text || '').replace(/\\s+/g, ' ').trim(); };
  var list = [];

  var blocks = Array.from(uniq);
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var link = block.querySelector('a[href]');
    var titleEl = block.querySelector('h3');
    if (!link || !titleEl) continue;

    var href = link.getAttribute('href') || '';
    if (href.indexOf('http') !== 0) continue;

    var title = clean(titleEl.textContent);
    if (!title) continue;

    var descEl =
      block.querySelector('div[data-sncf], div[data-snf], div[data-content-feature], .VwiC3b, div[role="text"], div.MUxGbd') ||
      block.querySelector('span');
    var description = clean(descEl ? (descEl.innerText || descEl.textContent || '') : '');

    list.push({ title: title, url: href, description: description });
    if (list.length >= limit) break;
  }

  return list.map(function(r, idx) { return { title: r.title, url: r.url, description: r.description, position: idx + 1 }; });
`;

export async function parseDomResults(
  page: any,
  count: number
): Promise<SearchResult[]> {
  const limit = Math.min(Math.max(count, 1), 100);

  const results = await page.evaluate(
    ({ script, limit }: { script: string; limit: number }) => {
      const fn = new Function("limit", script);
      return fn(limit);
    },
    { script: DOM_EXTRACTOR_SCRIPT, limit }
  );

  return results as SearchResult[];
}


