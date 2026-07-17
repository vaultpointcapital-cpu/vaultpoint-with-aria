import crypto from 'crypto';

const PAYSTACK_API_BASE = 'https://api.paystack.co';

function getPaystackSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new Error('PAYSTACK_SECRET_KEY is not set. Check .env.local against .env.example.');
  }
  return key;
}

export function getPaystackPlanCode(tier: 'pro' | 'elite'): string {
  const envVar = tier === 'pro' ? 'PAYSTACK_PLAN_PRO' : 'PAYSTACK_PLAN_ELITE';
  const planCode = process.env[envVar];
  if (!planCode) {
    throw new Error(`${envVar} is not set. Check .env.local against .env.example.`);
  }
  return planCode;
}

/** Inverse of getPaystackPlanCode — maps a webhook's plan_code back to
 * our internal tier. Returns null for a code that matches neither
 * configured tier. */
export function tierFromPaystackPlanCode(planCode: string | null | undefined): 'pro' | 'elite' | null {
  if (!planCode) return null;
  if (planCode === process.env.PAYSTACK_PLAN_PRO) return 'pro';
  if (planCode === process.env.PAYSTACK_PLAN_ELITE) return 'elite';
  return null;
}

interface InitializeTransactionParams {
  email: string;
  planCode: string;
  userId: string;
  callbackUrl: string;
}

interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data?: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

/**
 * Initializes a Paystack transaction for a subscription plan. `amount` is
 * deliberately omitted — when `plan` is provided, Paystack charges the
 * plan's own configured amount, so hardcoding an amount here would be a
 * second, driftable source of truth for pricing (see the "no hardcoded
 * Price IDs or Plan Codes" rule this spec calls out for the Stripe side;
 * the same principle applies to amounts on the Paystack side).
 */
export async function initializePaystackTransaction(
  params: InitializeTransactionParams
): Promise<{ url: string; reference: string }> {
  const response = await fetch(`${PAYSTACK_API_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getPaystackSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: params.email,
      plan: params.planCode,
      callback_url: params.callbackUrl,
      metadata: { user_id: params.userId },
    }),
  });

  const result = (await response.json()) as PaystackInitializeResponse;

  if (!response.ok || !result.status || !result.data) {
    throw new Error(`Paystack transaction initialize failed: ${result.message ?? response.statusText}`);
  }

  return { url: result.data.authorization_url, reference: result.data.reference };
}

/**
 * Verifies the x-paystack-signature header: HMAC-SHA512 of the raw
 * request body using PAYSTACK_SECRET_KEY, compared in constant time.
 * rawBody must be the exact bytes Paystack sent — never a re-serialized
 * JSON.parse(body) round-trip, which can change whitespace/key order and
 * break the signature.
 */
export function verifyPaystackSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;

  const expected = crypto.createHmac('sha512', getPaystackSecretKey()).update(rawBody).digest('hex');

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(signatureHeader, 'utf8');

  // timingSafeEqual throws if lengths differ, rather than returning false —
  // a mismatched-length signature is invalid, not an error condition.
  if (expectedBuffer.length !== receivedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
