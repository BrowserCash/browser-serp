export const MILLICENTS_PER_UNIT = 300;

const BALANCE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const balanceCache = new Map<string, { balance: number; expiresAt: number }>();

export function hasCredit(orgId: string): boolean {
  const entry = balanceCache.get(orgId);
  if (!entry || Date.now() > entry.expiresAt) return true; // unknown or stale — allow through
  return entry.balance >= MILLICENTS_PER_UNIT;
}

export function fireBilling(orgId: string, millicents: number, idempotencyKey: string): void {
  const baseUrl = process.env.BILLING_V2_BASE_URL;
  const serviceKey = process.env.BILLING_V2_SERVICE_KEY;
  if (!baseUrl || !serviceKey) return;

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10_000);

  void fetch(`${baseUrl}/v2/usage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-service-key': serviceKey,
    },
    body: JSON.stringify({ orgId, millicents, idempotencyKey }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) return;
      const data = await res.json() as { wallet?: { balance_millicents?: number } };
      const balance = data.wallet?.balance_millicents;
      if (typeof balance === 'number') {
        balanceCache.set(orgId, { balance, expiresAt: Date.now() + BALANCE_CACHE_TTL_MS });
      }
    })
    .catch(() => {});
}
