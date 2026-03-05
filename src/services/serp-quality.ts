import type { SearchExecutionResult } from './types.js';

const TITLE_BLOCK_SIGNATURES = [
  'just a moment',
  'checking your browser',
  'access denied',
  'are you a human',
  'captcha',
  'datadome',
  'press & hold',
];

export function isQualitySerpResult(result: SearchExecutionResult, minResults = 1): boolean {
  if (result.statusCode > 0 && (result.statusCode < 200 || result.statusCode > 399)) {
    return false;
  }

  if (result.blocked) return false;
  if (result.results.length === 0) return false;
  if (result.results.length < minResults) return false;

  for (const item of result.results) {
    if (!item.title || !item.url) return false;
    const title = item.title.toLowerCase();
    if (TITLE_BLOCK_SIGNATURES.some((signature) => title.includes(signature))) {
      return false;
    }
  }

  return true;
}
