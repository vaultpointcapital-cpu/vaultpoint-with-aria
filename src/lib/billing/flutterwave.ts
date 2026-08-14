import crypto from 'crypto';

const FLUTTERWAVE_API_BASE = 'https://api.flutterwave.com/v3';

// Flutterwave doesn't auto-derive a checkout amount from payment_plan the
// way Paystack does (verified empirically against the real v3 API in test
// mode — POST /v3/payments requires `amount` even when `payment_plan` is
// set). These MUST match the amount each plan was actually created with in
// Flutterwave (see scripts note in PAYSTACK_PLAN_PRO/ELITE's sibling env
// vars) — there's no API call this module makes to verify that at runtime,
// so a mismatch here would silently charge the wrong amount.
const TIER_AMOUNT_NGN: Record<'pro' | 'elite', number> = {
  pro: 20000,
  elite: 55000,
};

function getFlutterwaveSecretKey(): string {
  const key = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!key) {
    throw new Error('FLUTTERWAVE_SECRET_KEY is not set. Check .env.local against .env.example.');
  }
  return key;
}

export function getFlutterwavePlanId(tier: 'pro' | 'elite'): string {
  const envVar = tier === 'pro' ? 'FLUTTERWAVE_PLAN_PRO' : 'FLUTTERWAVE_PLAN_ELITE';
  const planId = process.env[envVar];
  if (!planId) {
    throw new Error(`${envVar} is not set. Check .env.local against .env.example.`);
  }
  return planId;
}

/** Inverse of getFlutterwavePlanId — used by the webhook to map a
 * recurring charge's payment_plan id back to our internal tier. Returns
 * null for a plan id that matches neither configured tier. */
export function tierFromFlutterwavePlanId(planId: string | number | null | undefined): 'pro' | 'elite' | null {
  if (planId == null) return null;
  const id = String(planId);
  if (id === process.env.FLUTTERWAVE_PLAN_PRO) return 'pro';
  if (id === process.env.FLUTTERWAVE_PLAN_ELITE) return 'elite';
  return null;
}

interface InitializeTransactionParams {
  email: string;
  tier: 'pro' | 'elite';
  userId: string;
  redirectUrl: string;
}

interface FlutterwaveInitializeResponse {
  status: string;
  message: string;
  data?: { link: string };
}

/**
 * Initializes a Flutterwave hosted-checkout transaction against a
 * recurring payment plan. tx_ref is generated here (not returned by
 * Flutterwave until after charge) — prefixed with the user id so a
 * webhook that only carries tx_ref (no meta echoed back, depending on
 * event type) can still be traced to a user as a fallback; meta.user_id
 * is the primary lookup path.
 */
export async function initializeFlutterwaveTransaction(
  params: InitializeTransactionParams
): Promise<{ url: string; txRef: string }> {
  const txRef = `vp_${params.userId}_${Date.now()}`;

  const response = await fetch(`${FLUTTERWAVE_API_BASE}/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getFlutterwaveSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tx_ref: txRef,
      amount: TIER_AMOUNT_NGN[params.tier],
      currency: 'NGN',
      redirect_url: params.redirectUrl,
      payment_plan: getFlutterwavePlanId(params.tier),
      customer: { email: params.email },
      meta: { user_id: params.userId },
    }),
  });

  const result = (await response.json()) as FlutterwaveInitializeResponse;

  if (!response.ok || result.status !== 'success' || !result.data?.link) {
    throw new Error(`Flutterwave transaction initialize failed: ${result.message ?? response.statusText}`);
  }

  return { url: result.data.link, txRef };
}

/**
 * Verifies the verif-hash webhook header: a static secret string you
 * configure once in the Flutterwave dashboard (Settings > Webhooks),
 * compared directly — NOT an HMAC of the request body. This is
 * Flutterwave's long-established v3 scheme (matches the official
 * flutterwave-node-v3 SDK and the majority of real integration guides),
 * but Flutterwave's own docs were genuinely inconsistent on this point
 * when this was built (one page describes an HMAC-SHA256
 * "flutterwave-signature" header instead). NOT YET VERIFIED against a
 * real webhook delivery — do that (Flutterwave dashboard has a
 * send-test-webhook feature) before trusting this in production, and
 * switch to HMAC comparison here if that's what a real delivery shows.
 */
export function verifyFlutterwaveSignature(signatureHeader: string | null): boolean {
  const secretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH;
  if (!secretHash || !signatureHeader) return false;

  const expectedBuffer = Buffer.from(secretHash, 'utf8');
  const receivedBuffer = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuffer.length !== receivedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
