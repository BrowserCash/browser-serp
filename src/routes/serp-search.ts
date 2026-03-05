import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clampCount } from '../services/query.js';
import type { SerpClient } from '../services/serp.js';
import type { SearchExecutionResult, SearchParams } from '../services/types.js';

const requestSchema = z
  .object({
    q: z.string().trim().min(1),
    gl: z.string().trim().min(2).max(16).optional(),
    hl: z.string().trim().min(2).max(16).optional(),
    location: z.string().trim().min(1).max(200).optional(),
    num: z.coerce.number().int().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).optional(),
    tbs: z.string().trim().min(1).max(64).optional(),
    autocorrect: z.boolean().optional(),
    type: z.string().optional(),
  })
  .passthrough();

type SerpRequestInput = z.infer<typeof requestSchema>;

interface SerpSearchRouteOptions {
  serpClient: SerpClient;
}
const BATCH_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.SERP_BATCH_CONCURRENCY || '8', 10) || 8
);

function toSearchParams(input: SerpRequestInput): SearchParams {
  const count = clampCount(input.num ?? 10);
  const page = input.page ?? 1;
  return {
    q: input.q,
    count,
    num: count,
    page,
    gl: input.gl ?? 'us',
    hl: input.hl ?? 'en',
    location: input.location,
    tbs: input.tbs,
    autocorrect: input.autocorrect,
    maxPages: 1,
    featureRich: page === 1,
  };
}

function searchParametersFromInput(input: SerpRequestInput): Record<string, unknown> {
  const params: Record<string, unknown> = {
    q: input.q,
    type: 'search',
  };

  if (input.gl) params.gl = input.gl;
  if (input.hl) params.hl = input.hl;
  if (input.location) params.location = input.location;
  if (typeof input.page === 'number') params.page = input.page;
  if (typeof input.num === 'number') params.num = input.num;
  if (input.tbs) params.tbs = input.tbs;
  if (typeof input.autocorrect === 'boolean') params.autocorrect = input.autocorrect;

  params.engine = 'google';
  return params;
}

function formatSerpResponse(input: SerpRequestInput, execution: SearchExecutionResult): Record<string, unknown> {
  const includeRichSections = (input.page ?? 1) === 1;
  return {
    searchParameters: searchParametersFromInput(input),
    ...(includeRichSections && execution.answerBox ? { answerBox: execution.answerBox } : {}),
    ...(includeRichSections && execution.knowledgeGraph ? { knowledgeGraph: execution.knowledgeGraph } : {}),
    organic: execution.organic,
    ...(includeRichSections && execution.topStories && execution.topStories.length > 0
      ? { topStories: execution.topStories }
      : {}),
    ...(includeRichSections && execution.peopleAlsoAsk && execution.peopleAlsoAsk.length > 0
      ? { peopleAlsoAsk: execution.peopleAlsoAsk }
      : {}),
    ...(includeRichSections && execution.relatedSearches && execution.relatedSearches.length > 0
      ? { relatedSearches: execution.relatedSearches }
      : {}),
    credits: 1,
  };
}

function formatSerpEmptyResponse(input: SerpRequestInput): Record<string, unknown> {
  return {
    searchParameters: searchParametersFromInput(input),
    organic: [],
    credits: 1,
  };
}

function shouldReturnBestEffort(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('timed out') || message.includes('quality checks');
}

function parseInput(raw: unknown): { ok: true; value: SerpRequestInput } | { ok: false; message: string } {
  const parsed = requestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };

  const hasMissingQ = parsed.error.issues.some((issue) => issue.path[0] === 'q');
  if (hasMissingQ) {
    return { ok: false, message: 'Missing query parameter' };
  }

  return { ok: false, message: 'Invalid request payload' };
}

export async function serpSearchRoute(app: FastifyInstance, opts: SerpSearchRouteOptions): Promise<void> {
  app.post('/search', async (req, reply) => {
    const payload = req.body as unknown;

    if (Array.isArray(payload)) {
      const items = payload.slice(0, 100);
      const out: Array<Record<string, unknown>> = new Array(items.length);

      let cursor = 0;
      const workerCount = Math.min(BATCH_CONCURRENCY, items.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;

          const rawItem = items[index];
          const parsed = parseInput(rawItem);
          if (!parsed.ok) {
            out[index] = {
              error: {
                message: parsed.message,
                statusCode: 400,
              },
            };
            continue;
          }

          try {
            const execution = await opts.serpClient.search(toSearchParams(parsed.value));
            out[index] = formatSerpResponse(parsed.value, execution);
          } catch (error) {
            if (shouldReturnBestEffort(error)) {
              out[index] = formatSerpEmptyResponse(parsed.value);
              continue;
            }
            out[index] = {
              error: {
                message: error instanceof Error ? error.message : 'upstream_error',
                statusCode: 502,
              },
            };
          }
        }
      });

      for (const worker of workers) {
        await worker;
      }

      return reply.status(200).send(out);
    }

    const parsed = parseInput(payload);
    if (!parsed.ok) {
      return reply.status(400).send({
        message: parsed.message,
        statusCode: 400,
      });
    }

    try {
      const execution = await opts.serpClient.search(toSearchParams(parsed.value));
      return reply.status(200).send(formatSerpResponse(parsed.value, execution));
    } catch (error) {
      if (shouldReturnBestEffort(error)) {
        return reply.status(200).send(formatSerpEmptyResponse(parsed.value));
      }

      return reply.status(502).send({
        message: error instanceof Error ? error.message : 'upstream_error',
        statusCode: 502,
      });
    }
  });
}
