export type WalletProvider = 'paystack' | 'stripe' | 'crypto';

/** Currency each wallet rail actually settles in — used both to validate a
 * deposit-initiate request's currency/provider pairing and to pick the
 * right payout rail at withdrawal-confirm time. */
export const CURRENCY_BY_WALLET_PROVIDER: Record<WalletProvider, string> = {
  paystack: 'NGN',
  stripe: 'USD',
  crypto: 'USDT',
};

/** Inverse of CURRENCY_BY_WALLET_PROVIDER — which rail processes a given
 * wallet currency's withdrawal payout. */
export function walletProviderForCurrency(currency: string): WalletProvider | null {
  const entry = (Object.entries(CURRENCY_BY_WALLET_PROVIDER) as [WalletProvider, string][]).find(
    ([, cur]) => cur === currency
  );
  return entry ? entry[0] : null;
}

/** App-level WalletProvider ('crypto') vs. the DB's wallet_provider enum
 * ('web3') use different vocabulary for the same rail — this maps between
 * them for wallet_apply_transaction() calls. */
export function walletProviderToDbEnum(provider: WalletProvider): 'paystack' | 'stripe' | 'web3' {
  return provider === 'crypto' ? 'web3' : provider;
}

/**
 * Resolves which rail a wallet deposit/withdrawal should use.
 *
 * Rule: country === 'NG' -> Paystack (NGN). Everything else -> Stripe (USD).
 * Unlike src/lib/billing/routing.ts's resolveProvider, this deliberately
 * excludes Flutterwave — the wallet only supports Paystack, Stripe, and
 * crypto for now. An explicit choice (including 'crypto', which is always a
 * user opt-in rather than geography-based) always wins over the
 * country-based default.
 */
export function resolveWalletProvider(params: {
  country: string | null | undefined;
  explicitProvider?: WalletProvider;
}): WalletProvider {
  if (params.explicitProvider) {
    return params.explicitProvider;
  }

  if (params.country === 'NG') return 'paystack';
  return 'stripe';
}
