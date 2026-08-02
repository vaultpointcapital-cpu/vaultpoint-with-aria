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

interface InitializeDepositParams {
  email: string;
  userId: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
}

/**
 * Initializes a Paystack transaction for a wallet deposit — amount-based,
 * unlike initializePaystackTransaction() above which is plan-based (Paystack
 * charges the plan's own configured amount for subscriptions). metadata.purpose
 * is set to 'wallet_deposit' so the webhook handler's charge.success case can
 * disambiguate this from a subscription charge, which also fires charge.success.
 */
export async function initializePaystackDeposit(
  params: InitializeDepositParams
): Promise<{ url: string; reference: string }> {
  const response = await fetch(`${PAYSTACK_API_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getPaystackSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: params.email,
      amount: params.amountKobo,
      reference: params.reference,
      callback_url: params.callbackUrl,
      metadata: { user_id: params.userId, purpose: 'wallet_deposit' },
    }),
  });

  const result = (await response.json()) as PaystackInitializeResponse;

  if (!response.ok || !result.status || !result.data) {
    throw new Error(`Paystack deposit initialize failed: ${result.message ?? response.statusText}`);
  }

  return { url: result.data.authorization_url, reference: result.data.reference };
}

interface TransferRecipientParams {
  name: string;
  accountNumber: string;
  bankCode: string;
}

interface PaystackTransferRecipientResponse {
  status: boolean;
  message: string;
  data?: { recipient_code: string };
}

interface PaystackTransferResponse {
  status: boolean;
  message: string;
  data?: { transfer_code: string; reference: string; status: string };
}

/**
 * Creates a Paystack transfer recipient. Required before initiatePaystackTransfer —
 * Paystack's Transfers API pays out to a recipient_code, not raw bank details
 * per call. Wallet withdrawal confirmation creates a fresh recipient per
 * withdrawal rather than caching one, since destination_details_encrypted is
 * only ever decrypted in memory for the duration of a single payout call
 * (same rule as broker keys — never persisted in plaintext, never logged).
 */
export async function createPaystackTransferRecipient(
  params: TransferRecipientParams
): Promise<{ recipientCode: string }> {
  const response = await fetch(`${PAYSTACK_API_BASE}/transferrecipient`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getPaystackSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'nuban',
      name: params.name,
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      currency: 'NGN',
    }),
  });

  const result = (await response.json()) as PaystackTransferRecipientResponse;
  if (!response.ok || !result.status || !result.data) {
    throw new Error(`Paystack transfer recipient creation failed: ${result.message ?? response.statusText}`);
  }
  return { recipientCode: result.data.recipient_code };
}

/**
 * Initiates a Paystack Transfer (withdrawal payout) to a previously created
 * recipient. Requires the Paystack business account's Transfers API to be
 * enabled for this business verification tier — confirm before relying on
 * this in production (PRD open question #2).
 */
export async function initiatePaystackTransfer(params: {
  amountKobo: number;
  recipientCode: string;
  reference: string;
  reason: string;
}): Promise<{ transferCode: string; status: string }> {
  const response = await fetch(`${PAYSTACK_API_BASE}/transfer`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getPaystackSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'balance',
      amount: params.amountKobo,
      recipient: params.recipientCode,
      reference: params.reference,
      reason: params.reason,
    }),
  });

  const result = (await response.json()) as PaystackTransferResponse;
  if (!response.ok || !result.status || !result.data) {
    throw new Error(`Paystack transfer failed: ${result.message ?? response.statusText}`);
  }
  return { transferCode: result.data.transfer_code, status: result.data.status };
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
