import type { BrowserPoolManager } from '../pool/manager.js';
import type { PageSlotRef, ScrapeAttemptOutcome as PoolAttemptOutcome } from '../pool/types.js';
import { buildGoogleSearchUrl } from './query.js';
import { runGoogleSearch } from './search.js';
import { isQualitySerpResult } from './serp-quality.js';
import type { SearchExecutionResult, SearchParams } from './types.js';

interface SearchAttemptOutcome {
  sessionId: string;
  success: boolean;
  qualityPass: boolean;
  result?: SearchExecutionResult;
  error?: string;
  elapsedMs: number;
}

export interface SerpRaceExecution {
  result: SearchExecutionResult;
  cleanupPromise: Promise<void>;
}

const parsedHedgeDelayMs = Number.parseInt(process.env.SERP_HEDGE_DELAY_MS || '100', 10);
const HEDGE_DELAY_MS = Number.isFinite(parsedHedgeDelayMs) ? parsedHedgeDelayMs : 100;
const parsedRecoveryAttempts = Number.parseInt(process.env.SERP_RECOVERY_ATTEMPTS || '1', 10);
const RECOVERY_ATTEMPTS = Number.isFinite(parsedRecoveryAttempts) ? Math.max(0, parsedRecoveryAttempts) : 0;

export async function searchWithBrowserPool(params: SearchParams, pool: BrowserPoolManager): Promise<SerpRaceExecution> {
  const allOutcomes: SearchAttemptOutcome[] = [];
  const sourceUrl = buildGoogleSearchUrl(params, 0, 10);

  const firstRound = await runRaceRound(params, pool, sourceUrl, allOutcomes);
  void firstRound.cleanupPromise.catch(() => {});

  if (firstRound.winner?.result) {
    return {
      result: firstRound.winner.result,
      cleanupPromise: firstRound.cleanupPromise,
    };
  }

  const firstRoundBest = pickBestResult(allOutcomes);
  const firstRoundMin = Math.max(3, Math.min(params.count, 5));
  if (firstRoundBest && firstRoundBest.results.length >= firstRoundMin) {
    return {
      result: firstRoundBest,
      cleanupPromise: firstRound.cleanupPromise,
    };
  }

  if (RECOVERY_ATTEMPTS > 0) {
    const recovered = await runFreshRecovery(params, pool, sourceUrl, RECOVERY_ATTEMPTS, allOutcomes);
    if (recovered) {
      return {
        result: recovered,
        cleanupPromise: Promise.resolve(),
      };
    }
  }

  const best = pickBestResult(allOutcomes);
  if (best) {
    return {
      result: best,
      cleanupPromise: Promise.resolve(),
    };
  }

  throw new Error('All pooled SERP attempts failed quality checks');
}

function pickBestResult(outcomes: SearchAttemptOutcome[]): SearchExecutionResult | undefined {
  let best: SearchExecutionResult | undefined;

  for (const outcome of outcomes) {
    if (!outcome.result) continue;
    if (!best || outcome.result.results.length > best.results.length) {
      best = outcome.result;
    }
  }

  return best;
}

interface RaceRound {
  winner?: SearchAttemptOutcome;
  cleanupPromise: Promise<void>;
}

async function runRaceRound(
  params: SearchParams,
  pool: BrowserPoolManager,
  sourceUrl: string,
  collectOutcomes?: SearchAttemptOutcome[]
): Promise<RaceRound> {
  const lease = await pool.acquireLease();
  const abortSignal = { aborted: false };

  const attempts = lease.slots.map((slot, index) =>
    runAttemptWithHedgeDelay(params, slot, pool.attemptTimeoutMs, abortSignal, index * Math.max(0, HEDGE_DELAY_MS))
  );
  const releasePromises = attempts.map((attempt, index) =>
    attempt.then((outcome) => {
      const slot = lease.slots[index];
      if (!slot) return;
      return pool.releaseSlot(slot.browserNodeSessionId, slot.slotIndex, toPoolOutcome(outcome), sourceUrl);
    })
  );

  const cleanupPromise = Promise.allSettled(releasePromises).then(() => undefined);

  try {
    const winner = await firstPassingAttempt(attempts);
    abortSignal.aborted = true;
    if (collectOutcomes) collectOutcomes.push(winner);
    return { winner, cleanupPromise };
  } catch {
    if (collectOutcomes) {
      const settled = await Promise.allSettled(attempts);
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          collectOutcomes.push(outcome.value);
        }
      }
    }

    return { cleanupPromise };
  }
}

async function runFreshRecovery(
  params: SearchParams,
  pool: BrowserPoolManager,
  sourceUrl: string,
  attempts: number,
  collectOutcomes?: SearchAttemptOutcome[]
): Promise<SearchExecutionResult | null> {
  const leasesRaw = await Promise.all(
    Array.from({ length: attempts }, (_, index) => pool.acquireFreshLease(params.q, index).catch(() => null))
  );
  const leases = leasesRaw.filter((lease): lease is NonNullable<typeof lease> => Boolean(lease));
  if (leases.length === 0) return null;

  const outcomes = await Promise.all(
    leases.map((lease) => {
      const slot = lease.slots[0];
      if (!slot) {
        return Promise.resolve<SearchAttemptOutcome>({
          sessionId: 'missing-slot',
          success: false,
          qualityPass: false,
          error: 'Missing slot in recovery lease',
          elapsedMs: 0,
        });
      }

      return runAttempt(params, slot, pool.attemptTimeoutMs);
    })
  );

  if (collectOutcomes) collectOutcomes.push(...outcomes);

  void Promise.allSettled(
    leases.map((lease, idx) => {
      const outcome = outcomes[idx];
      return pool.releaseLease(lease, outcome ? [toPoolOutcome(outcome)] : [], sourceUrl);
    })
  ).catch(() => {});

  const winner = outcomes.find((outcome) => outcome.qualityPass && outcome.result)?.result;
  return winner ?? null;
}

async function runAttempt(
  params: SearchParams,
  slot: PageSlotRef,
  timeoutMs: number,
  abortSignal?: { aborted: boolean }
): Promise<SearchAttemptOutcome> {
  const startedAt = Date.now();
  const profile = getAttemptProfile(timeoutMs, params.count);
  const isWarm = Boolean(slot.warm && !slot.warm.client.closed);

  const executionConfig = {
    timeoutMs: profile.timeoutMs,
    networkIdleMs: profile.networkIdleMs,
    stabilityPollMs: profile.stabilityPollMs,
    stabilityChecks: profile.stabilityChecks,
    abortSignal,
  };

  try {
    let result: SearchExecutionResult;
    if (isWarm) {
      try {
        result = await withTimeout(runGoogleSearch(slot.warm!, params, executionConfig), profile.timeoutMs + 1_000);
      } catch {
        slot.warm = null;
        result = await withTimeout(runGoogleSearch(slot.cdpUrl, params, executionConfig), profile.timeoutMs + 1_000);
      }
    } else {
      result = await withTimeout(runGoogleSearch(slot.cdpUrl, params, executionConfig), profile.timeoutMs + 1_000);
    }

    const minResults = Math.max(1, Math.min(params.count, 5));
    const quality = isQualitySerpResult(result, minResults);

    return {
      sessionId: slot.sessionId,
      success: true,
      qualityPass: quality,
      result,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      sessionId: slot.sessionId,
      success: false,
      qualityPass: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

async function runAttemptWithHedgeDelay(
  params: SearchParams,
  slot: PageSlotRef,
  timeoutMs: number,
  abortSignal: { aborted: boolean },
  delayMs: number
): Promise<SearchAttemptOutcome> {
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  if (abortSignal.aborted) {
    return {
      sessionId: slot.sessionId,
      success: false,
      qualityPass: false,
      error: 'aborted_by_race_winner',
      elapsedMs: 0,
    };
  }

  return runAttempt(params, slot, timeoutMs, abortSignal);
}

interface AttemptProfile {
  timeoutMs: number;
  networkIdleMs: number;
  stabilityPollMs: number;
  stabilityChecks: number;
}

function getAttemptProfile(timeoutMs: number, count: number): AttemptProfile {
  const boundedTimeoutMs = count <= 10 ? Math.min(timeoutMs, 5_000) : Math.min(timeoutMs, 8_500);
  return {
    timeoutMs: boundedTimeoutMs,
    networkIdleMs: 0,
    stabilityPollMs: 60,
    stabilityChecks: 1,
  };
}

function firstPassingAttempt(attempts: Array<Promise<SearchAttemptOutcome>>): Promise<SearchAttemptOutcome> {
  return new Promise((resolve, reject) => {
    if (attempts.length === 0) {
      reject(new Error('No available pooled browser slots'));
      return;
    }

    let pending = attempts.length;
    let settled = false;

    for (const attempt of attempts) {
      attempt
        .then((outcome) => {
          if (settled) return;

          if (outcome.qualityPass && outcome.result) {
            settled = true;
            resolve(outcome);
            return;
          }

          pending -= 1;
          if (pending === 0) {
            reject(new Error('No passing pooled SERP attempts'));
          }
        })
        .catch((error) => {
          if (settled) return;

          pending -= 1;
          if (pending === 0) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
    }
  });
}

function toPoolOutcome(outcome: SearchAttemptOutcome): PoolAttemptOutcome {
  return {
    sessionId: outcome.sessionId,
    success: outcome.success,
    qualityPass: outcome.qualityPass,
    finalUrl: outcome.result?.finalUrl,
    error: outcome.error,
    elapsedMs: outcome.elapsedMs,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Attempt timeout after ${timeoutMs}ms`)), timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
