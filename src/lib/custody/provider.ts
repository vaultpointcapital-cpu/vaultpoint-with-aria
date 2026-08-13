import { CoboAdapter } from './cobo-adapter';

export interface DepositAddressResult {
  providerWalletId: string;
  address: string;
  chain: string;
}

export interface WithdrawalResult {
  providerTxId: string;
}

/**
 * Provider-agnostic custody interface (spec section 3's "ledger and
 * custody are separate layers" principle) — src/lib/wallet/web3-adapter.ts
 * is the only caller, and never talks to a specific vendor's SDK
 * directly. Migrating providers later (Cobo -> BitGo, per the spec's own
 * "when to reconsider") means writing a new class here, not touching the
 * wallet flow, the ledger schema, or the UI.
 */
export interface CustodyProvider {
  getOrCreateDepositAddress(params: { userId: string; chain: string }): Promise<DepositAddressResult>;
  initiateWithdrawal(params: {
    chain: string;
    asset: string;
    amount: number;
    destinationAddress: string;
  }): Promise<WithdrawalResult>;
  /** For the reconciliation cron — VaultPoint's total balance of `asset` on `chain`, per the provider. */
  getAccountBalance(params: { chain: string; asset: string }): Promise<number>;
  verifyWebhookSignature(params: { rawBody: string; headers: Headers }): boolean;
}

/**
 * Returns a real CustodyProvider only when explicitly enabled AND
 * credentials are present — defaults OFF. See cobo-adapter.ts's module
 * docstring for why: its request-signing and webhook-verification
 * schemes are unverified against Cobo's live API, and this table
 * structure will hold real user crypto once enabled. Every existing
 * caller (web3-adapter.ts) treats a null return as "keep behaving like
 * the placeholder does today," so leaving this flag off is a complete,
 * safe no-op — nothing else in the codebase changes behavior.
 */
export function getFeatureCustodyProvider(): CustodyProvider | null {
  if (process.env.COBO_INTEGRATION_ENABLED !== 'true') return null;
  if (!process.env.COBO_API_KEY || !process.env.COBO_API_SECRET || !process.env.COBO_WALLET_ID) return null;
  return new CoboAdapter();
}
