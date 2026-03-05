import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOrganicResults, normalizeSearchResults, normalizeSerpPayload } from '../extractor.js';

test('normalizeSearchResults canonicalizes, dedupes, and reindexes', () => {
  const raw = [
    {
      title: 'Result A',
      url: '/url?q=https%3A%2F%2Fexample.com%2Fpath%3Fved%3Dabc%26x%3D1',
      description: 'A',
    },
    {
      title: 'Result A duplicate',
      url: 'https://example.com/path?ved=zzz&x=1',
      description: 'dup',
    },
    {
      title: 'Result B',
      url: 'https://example.org/page#fragment',
      description: 'B',
    },
    {
      title: 'Map',
      url: 'https://www.google.com/search?q=example',
      description: 'internal',
    },
    {
      title: '',
      url: 'https://invalid.example',
      description: 'invalid',
    },
  ];

  const normalized = normalizeSearchResults(raw, 10);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0]?.url, 'https://example.com/path?x=1');
  assert.equal(normalized[0]?.position, 1);
  assert.equal(normalized[1]?.url, 'https://example.org/page');
  assert.equal(normalized[1]?.position, 2);
});

test('normalizeSerpPayload filters noisy knowledgeGraph attribute keys', () => {
  const payload = normalizeSerpPayload(
    {
      organic: [
        {
          title: 'Result A',
          url: 'https://example.com',
          description: 'A',
        },
      ],
      knowledgeGraph: {
        title: 'Apple',
        attributes: {
          '0': 'junk',
          'Customer service': '1 (800) 275-2273',
          'bad/key': 'noise',
        },
      },
    },
    10
  );

  assert.ok(payload.knowledgeGraph);
  assert.deepEqual(payload.knowledgeGraph?.attributes, {
    'Customer service': '1 (800) 275-2273',
  });
});

test('normalizeSerpPayload enriches KG source/link from organic wikipedia result', () => {
  const payload = normalizeSerpPayload(
    {
      organic: [
        {
          title: 'Apple Inc.',
          url: 'https://en.wikipedia.org/wiki/Apple_Inc.',
          description:
            'Apple Inc. is an American multinational technology company headquartered in Cupertino, California.',
        },
      ],
      knowledgeGraph: {
        title: 'Apple',
        attributes: {
          Founded: 'April 1, 1976',
        },
      },
    },
    10
  );

  assert.ok(payload.knowledgeGraph);
  assert.equal(payload.knowledgeGraph?.descriptionSource, 'Wikipedia');
  assert.equal(payload.knowledgeGraph?.descriptionLink, 'https://en.wikipedia.org/wiki/Apple_Inc.');
  assert.match(payload.knowledgeGraph?.description || '', /American multinational technology company/);
});

test('normalizeOrganicResults filters generic sitelinks like Read more and parent link duplicates', () => {
  const payload = normalizeOrganicResults(
    [
      {
        title: 'Firefox',
        url: 'https://www.firefox.com',
        description: 'Browser',
        sitelinks: [
          { title: 'Read more', link: 'https://www.firefox.com' },
          { title: 'More results from firefox.com »', link: 'https://www.google.com/search?q=site%3Afirefox.com' },
          { title: 'For Windows', link: 'https://www.firefox.com/download/windows/' },
        ],
      },
    ],
    10
  );

  assert.equal(payload.length, 1);
  assert.deepEqual(payload[0]?.sitelinks, [
    { title: 'For Windows', link: 'https://www.firefox.com/download/windows/' },
  ]);
});
