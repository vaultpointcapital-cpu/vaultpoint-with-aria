import crypto from 'crypto';
import type { CustodyProvider, DepositAddressResult, WithdrawalResult } from './provider';

/**
 * ============================================================================
 * UNVERIFIED — best-effort Cobo WaaS integration. Read before touching.
 * ============================================================================
 * Every endpoint path, header name, and the request-signing / webhook-
 * signature-verification scheme below is written from general knowledge
 * of Cobo's publicly documented Wallet-as-a-Service API, NOT verified
 * against a live account, a real sandbox call, or Cobo's current API
 * reference. Nothing in this file has been exercised against Cobo.
 *
 * Confirm every constant below (COBO_BASE_URL, the endpoint paths, the
 * exact signing header names/algorithm, the webhook signature
 * header/algorithm) against Cobo's live developer docs and a real
 * sandbox call before COBO_INTEGRATION_ENABLED is ever set true
 * somewhere real funds could reach this code path.
 *
 * getting the webhook signature check wrong here is a SECURITY bug, not
 * a compatibility bug — verifyWebhookSignature is the only thing
 * standing between "Cobo confirmed this deposit really happened" and
 * "anyone who finds the webhook endpoint can credit themselves crypto."
 * If a real integration attempt shows the header names or algorithm
 * below are wrong, fix this function before fixing anything else in
 * this file.
 * ============================================================================
 */

const COBO_BASE_URL = process.env.COBO_API_BASE_URL ?? 'https://api.cobo.com'; // sandbox is commonly api.dev.cobo.com — VERIFY
const REQUEST_TIMEOUT_MS = 20_000;

interface CoboAddressResponse {
  addresses?: { address: string }[];
}
interface CoboTransactionResponse {
  transaction_id?: string;
}
interface CoboBalanceResponse {
  balance?: string;
}

export class CoboAdapter implements CustodyProvider {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly walletId: string;

  constructor() {
    const apiKey = process.env.COBO_API_KEY;
    const apiSecret = process.env.COBO_API_SECRET;
    const walletId = process.env.COBO_WALLET_ID;
    if (!apiKey || !apiSecret || !walletId) {
      throw new Error('COBO_API_KEY, COBO_API_SECRET, and COBO_WALLET_ID must all be set to construct CoboAdapter.');
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.walletId = walletId;
  }

  async getOrCreateDepositAddress({ chain }: { userId: string; chain: string }): Promise<DepositAddressResult> {
    // VERIFY: assumes one org-controlled Cobo wallet (COBO_WALLET_ID) pools
    // all users' funds, with per-user addresses derived within it — a
    // common "hosted wallet" shape for exchanges/fintechs, matching what
    // the spec itself flags as needing confirmation ("per-user vs
    // per-transaction deposit address model with Cobo's technical team",
    // Open Item #2). If Cobo's actual model is per-transaction addresses
    // instead, this method's single-address-per-user assumption is wrong
    // and needs revisiting alongside that open item.
    const path = `/v2/wallets/${this.walletId}/addresses`;
    const body = await this.request<CoboAddressResponse>('POST', path, { chain_id: chain, count: 1 });

    const address = body.addresses?.[0]?.address;
    if (!address) {
      throw new Error('Cobo did not return a deposit address.');
    }

    return { providerWalletId: this.walletId, address, chain };
  }

  async initiateWithdrawal({
    chain,
    asset,
    amount,
    destinationAddress,
  }: {
    chain: string;
    asset: string;
    amount: number;
    destinationAddress: string;
  }): Promise<WithdrawalResult> {
    const path = '/v2/transactions/transfer';
    const body = await this.request<CoboTransactionResponse>('POST', path, {
      request_id: crypto.randomUUID(),
      source: { source_type: 'Org-Controlled', wallet_id: this.walletId },
      destination: { destination_type: 'Address', address: destinationAddress },
      token_id: `${chain}_${asset}`,
      amount: amount.toString(),
    });

    if (!body.transaction_id) {
      throw new Error('Cobo did not return a transaction id for this withdrawal.');
    }

    return { providerTxId: body.transaction_id };
  }

  async getAccountBalance({ chain, asset }: { chain: string; asset: string }): Promise<number> {
    const path = `/v2/wallets/${this.walletId}/tokens/${chain}_${asset}`;
    const body = await this.request<CoboBalanceResponse>('GET', path);
    return parseFloat(body.balance ?? '0');
  }

  /**
   * VERIFY: header names (`biz-timestamp` / `biz-signature`) and the
   * signing algorithm (HMAC-SHA256 over `${timestamp}.${rawBody}`) are a
   * best guess at a common webhook-verification shape, not confirmed
   * against Cobo's actual webhook delivery format. See this file's
   * module docstring — fix this method first if a real delivery shows
   * it's wrong.
   */
  verifyWebhookSignature({ rawBody, headers }: { rawBody: string; headers: Headers }): boolean {
    const secret = process.env.COBO_WEBHOOK_SECRET;
    const signature = headers.get('biz-signature');
    const timestamp = headers.get('biz-timestamp');
    if (!secret || !signature || !timestamp) return false;

    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(signature, 'utf8');

    if (expectedBuffer.length !== receivedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  }

  /** VERIFY: signing header names (`BIZ-API-KEY`/`BIZ-API-TIMESTAMP`/`BIZ-API-SIGNATURE`) and the canonical-string shape being signed. */
  private sign(method: string, path: string, timestamp: string, body: string): string {
    const canonical = `${method.toUpperCase()}|${path}|${timestamp}|${body}`;
    return crypto.createHmac('sha256', this.apiSecret).update(canonical).digest('hex');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const timestamp = Date.now().toString();
    const bodyString = body ? JSON.stringify(body) : '';
    const signature = this.sign(method, path, timestamp, bodyString);

    const response = await fetch(`${COBO_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'BIZ-API-KEY': this.apiKey,
        'BIZ-API-TIMESTAMP': timestamp,
        'BIZ-API-SIGNATURE': signature,
      },
      body: bodyString || undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Cobo API request failed (${response.status} ${method} ${path}): ${text.slice(0, 300)}`);
    }

    return (await response.json()) as T;
  }
}
