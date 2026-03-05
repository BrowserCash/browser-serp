import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { serpSearchRoute } from '../serp-search.js';
import type { SearchExecutionResult, SearchParams, SerpClient } from '../../services/serp.js';

function createStubClient(): SerpClient {
  return {
    async init() {},
    async search(params: SearchParams) {
      const execution: SearchExecutionResult = {
        results: [
          {
            title: `Result for ${params.q}`,
            url: 'https://example.com',
            description: 'Example snippet',
            position: 1,
          },
        ],
        organic: [
          {
            title: `Result for ${params.q}`,
            link: 'https://example.com',
            snippet: 'Example snippet',
            position: 1,
          },
        ],
        relatedSearches: [{ query: 'example query' }],
        blocked: false,
        finalUrl: 'https://www.google.com/search?q=test',
        statusCode: 200,
        navigations: 1,
        totalTimeMs: 100,
      };
      return execution;
    },
    async shutdown() {},
    stats() {
      return {
        size: 1,
        available: 1,
        active: 0,
        totalNodes: 1,
        totalSlots: 1,
        inUse: 0,
      };
    },
  };
}

test('POST /api/v1/search returns Serp-compatible shape', async () => {
  const app = Fastify();
  await app.register(serpSearchRoute, { prefix: '/api/v1', serpClient: createStubClient() });

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/search',
    payload: {
      q: 'apple inc',
      page: 2,
      tbs: 'qdr:m',
    },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  const searchParameters = body.searchParameters as Record<string, unknown>;
  assert.equal(searchParameters.q, 'apple inc');
  assert.equal(searchParameters.page, 2);
  assert.equal(searchParameters.tbs, 'qdr:m');
  assert.equal(searchParameters.engine, 'google');
  assert.equal(Array.isArray(body.organic), true);
  assert.equal(body.credits, 1);

  await app.close();
});

test('POST /api/v1/search does not require X-API-KEY', async () => {
  process.env.BROWSER_CASH_API_KEY = 'backend-key';

  const app = Fastify();
  await app.register(serpSearchRoute, { prefix: '/api/v1', serpClient: createStubClient() });

  const noHeader = await app.inject({
    method: 'POST',
    url: '/api/v1/search',
    payload: { q: 'apple inc' },
  });
  assert.equal(noHeader.statusCode, 200);

  const withWrongHeader = await app.inject({
    method: 'POST',
    url: '/api/v1/search',
    headers: {
      'x-api-key': 'not-used-anymore',
    },
    payload: { q: 'apple inc' },
  });
  assert.equal(withWrongHeader.statusCode, 200);

  delete process.env.BROWSER_CASH_API_KEY;
  await app.close();
});

test('POST /api/v1/search supports mini-batch and per-item errors', async () => {
  const app = Fastify();
  await app.register(serpSearchRoute, { prefix: '/api/v1', serpClient: createStubClient() });

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/search',
    payload: [{ q: 'apple inc' }, {}],
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(body), true);
  assert.equal(body.length, 2);

  const first = body[0] as Record<string, unknown>;
  assert.equal(first.credits, 1);

  const second = body[1] as Record<string, unknown>;
  const error = second.error as Record<string, unknown>;
  assert.equal(error.statusCode, 400);

  await app.close();
});
