import type { UserContext } from './types.js';

const CONSUMER_ME_URL = 'https://lisa-taurine.tera.space/v1/consumer/me';
const CACHE_TTL_MS = 60_000;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 2;

const cache = new Map<string, { context: UserContext; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}, 5 * 60 * 1000).unref();

async function fetchConsumerMe(apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    return await fetch(CONSUMER_ME_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'browsercash-api/1.0' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function validateApiKey(apiKey: string): Promise<UserContext | null> {
  const now = Date.now();
  const cached = cache.get(apiKey);
  if (cached && cached.expiresAt > now) return cached.context;

  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchConsumerMe(apiKey);
      lastStatus = response.status;

      // Definitive auth failure — don't retry
      if (response.status === 401 || response.status === 403) return null;

      if (response.ok) {
        const data = await response.json() as {
          user: { id: number; consumerId: string; orgId: string; email: string };
        };
        const context: UserContext = {
          userId: data.user.id,
          consumerId: data.user.consumerId,
          orgId: data.user.orgId,
          email: data.user.email,
        };
        cache.set(apiKey, { context, expiresAt: now + CACHE_TTL_MS });
        return context;
      }

      // 5xx or unexpected — retry
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    } catch {
      // Network error / timeout — retry
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }

  // All attempts failed — return stale cache if available rather than blocking the user
  if (cached) return cached.context;

  return null;
}
