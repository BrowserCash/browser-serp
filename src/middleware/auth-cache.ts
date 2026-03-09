import type { UserContext } from './types.js';

const CONSUMER_ME_URL = 'https://lisa-taurine.tera.space/v1/consumer/me';
const CACHE_TTL_MS = 60_000;
const AUTH_TIMEOUT_MS = 5_000;

const cache = new Map<string, { context: UserContext; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}, 5 * 60 * 1000).unref();

export async function validateApiKey(apiKey: string): Promise<UserContext | null> {
  const now = Date.now();
  const cached = cache.get(apiKey);
  if (cached && cached.expiresAt > now) return cached.context;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

    const response = await fetch(CONSUMER_ME_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return null;

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
  } catch {
    return null;
  }
}
