import type { SearchParams } from './types.js';

const FRESHNESS_TBS: Record<NonNullable<SearchParams['freshness']>, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
};

export function clampCount(count: number): number {
  if (!Number.isFinite(count)) return 10;
  return Math.min(Math.max(Math.floor(count), 1), 100);
}

export function buildGoogleSearchUrl(params: SearchParams, start = 0, requestCount = clampCount(params.count)): string {
  const count = clampCount(params.num ?? requestCount);
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const baseStart = (page - 1) * 10;

  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', params.q);
  url.searchParams.set('num', String(count));
  url.searchParams.set('start', String(Math.max(0, baseStart + start)));
  url.searchParams.set('hl', params.hl || params.search_lang || 'en');

  const gl = params.gl || params.country;
  if (gl) {
    url.searchParams.set('gl', gl.toLowerCase());
  }

  if (params.safesearch) {
    if (params.safesearch === 'off') {
      url.searchParams.set('safe', 'off');
    } else {
      url.searchParams.set('safe', 'active');
    }
  }

  if (params.tbs) {
    url.searchParams.set('tbs', params.tbs);
  } else if (params.freshness) {
    url.searchParams.set('tbs', FRESHNESS_TBS[params.freshness]);
  }

  if (params.autocorrect === false) {
    // Disable spelling correction.
    url.searchParams.set('nfpr', '1');
  } else if (params.autocorrect === true) {
    url.searchParams.set('nfpr', '0');
  }

  if (params.location) {
    // Best-effort location hint for Google without dedicated geocode metadata.
    url.searchParams.set('near', params.location);
  }

  return url.toString();
}

export function canonicalizeResultUrl(raw: string): string | null {
  if (!raw) return null;

  let candidate = raw.trim();
  if (!candidate) return null;

  // Google redirect links: /url?q=https://example.com&sa=...
  if (candidate.startsWith('/url?')) {
    try {
      const wrapped = new URL(candidate, 'https://www.google.com');
      const q = wrapped.searchParams.get('q');
      if (q) candidate = q;
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';

    // Remove Google click-tracking params where present.
    parsed.searchParams.delete('ved');
    parsed.searchParams.delete('ei');
    parsed.searchParams.delete('sa');
    parsed.searchParams.delete('usg');
    parsed.searchParams.delete('source');

    return parsed.toString();
  } catch {
    return null;
  }
}
