export const MILLICENTS_PER_UNIT = 300;

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
  }).catch(() => {});
}
