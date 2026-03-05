import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGoogleSearchUrl, canonicalizeResultUrl, clampCount } from '../query.js';

test('buildGoogleSearchUrl maps params to google query string', () => {
  const url = new URL(
    buildGoogleSearchUrl(
      {
        q: 'best laptops',
        count: 12,
        country: 'US',
        search_lang: 'en',
        safesearch: 'moderate',
        freshness: 'week',
      },
      20,
      15
    )
  );

  assert.equal(url.hostname, 'www.google.com');
  assert.equal(url.searchParams.get('q'), 'best laptops');
  assert.equal(url.searchParams.get('start'), '20');
  assert.equal(url.searchParams.get('num'), '15');
  assert.equal(url.searchParams.get('hl'), 'en');
  assert.equal(url.searchParams.get('gl'), 'us');
  assert.equal(url.searchParams.get('safe'), 'active');
  assert.equal(url.searchParams.get('tbs'), 'qdr:w');
});

test('canonicalizeResultUrl unwraps google redirect url', () => {
  const canonical = canonicalizeResultUrl('/url?q=https%3A%2F%2Fexample.com%2Fpath%3Fved%3Dabc%26x%3D1%26sa%3DU');
  assert.equal(canonical, 'https://example.com/path?x=1');
});

test('clampCount enforces [1,100]', () => {
  assert.equal(clampCount(0), 1);
  assert.equal(clampCount(1), 1);
  assert.equal(clampCount(101), 100);
});
