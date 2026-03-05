import assert from 'node:assert/strict';
import test from 'node:test';
import { isQualitySerpResult } from '../serp-quality.js';

test('isQualitySerpResult accepts normal results', () => {
  const results = [
    { title: 'OpenAI', url: 'https://openai.com/', description: 'site', position: 1 },
    { title: 'TypeScript', url: 'https://www.typescriptlang.org/', description: 'docs', position: 2 },
    { title: 'Node.js', url: 'https://nodejs.org/', description: 'runtime', position: 3 },
    { title: 'Fastify', url: 'https://fastify.dev/', description: 'framework', position: 4 },
    { title: 'MDN', url: 'https://developer.mozilla.org/', description: 'reference', position: 5 },
  ];

  const ok = isQualitySerpResult({
    results,
    organic: results.map((result) => ({
      title: result.title,
      link: result.url,
      snippet: result.description,
      position: result.position,
    })),
    blocked: false,
    finalUrl: 'https://www.google.com/search?q=test',
    statusCode: 200,
    navigations: 1,
    totalTimeMs: 1200,
  });

  assert.equal(ok, true);
});

test('isQualitySerpResult rejects blocked and challenge-like results', () => {
  const blocked = isQualitySerpResult({
    results: [],
    organic: [],
    blocked: true,
    finalUrl: 'https://www.google.com/search?q=test',
    statusCode: 200,
    navigations: 1,
    totalTimeMs: 900,
  });

  const tooFew = isQualitySerpResult(
    {
      results: [
        { title: 'OpenAI', url: 'https://openai.com/', description: 'site', position: 1 },
      ],
      organic: [
        { title: 'OpenAI', link: 'https://openai.com/', snippet: 'site', position: 1 },
      ],
      blocked: false,
      finalUrl: 'https://www.google.com/search?q=test',
      statusCode: 200,
      navigations: 1,
      totalTimeMs: 900,
    },
    5
  );

  const challengeTitle = isQualitySerpResult({
    results: [
      {
        title: 'Just a moment...',
        url: 'https://example.com/',
        description: 'challenge',
        position: 1,
      },
    ],
    organic: [
      {
        title: 'Just a moment...',
        link: 'https://example.com/',
        snippet: 'challenge',
        position: 1,
      },
    ],
    blocked: false,
    finalUrl: 'https://www.google.com/search?q=test',
    statusCode: 200,
    navigations: 1,
    totalTimeMs: 900,
  });

  assert.equal(blocked, false);
  assert.equal(tooFew, false);
  assert.equal(challengeTitle, false);
});
