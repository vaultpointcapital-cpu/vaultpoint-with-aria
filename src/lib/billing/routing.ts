export type BillingProvider = 'stripe' | 'paystack' | 'flutterwave';

// Other African markets Flutterwave has strong local payment method
// support in, distinct from Paystack's Nigeria-only remit here. Not
// exhaustive by design — Flutterwave supports more countries than this;
// add to this list as VaultPoint actually launches in more markets,
// rather than routing every non-Nigerian African country through it
// speculatively ahead of any real product decision to operate there.
const FLUTTERWAVE_COUNTRIES = new Set(['GH', 'KE', 'UG', 'TZ', 'ZA']);

/**
 * Resolves which payment provider a checkout should use.
 *
 * Rule: country === 'NG' -> Paystack (NGN, Nigeria's primary rail).
 * country in FLUTTERWAVE_COUNTRIES -> Flutterwave (other African markets).
 * Everything else -> Stripe (international, USD). An explicit
 * preferredProvider always wins over the country-based default, for
 * users who want to switch (e.g. a Nigerian user who'd rather pay in USD).
 */
export function resolveProvider(params: {
  country: string | null | undefined;
  preferredProvider?: BillingProvider;
}): BillingProvider {
  if (params.preferredProvider) {
    return params.preferredProvider;
  }

  if (params.country === 'NG') return 'paystack';
  if (params.country && FLUTTERWAVE_COUNTRIES.has(params.country)) return 'flutterwave';
  return 'stripe';
}
