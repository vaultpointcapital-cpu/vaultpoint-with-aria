export type BillingProvider = 'stripe' | 'paystack';

/**
 * Resolves which payment provider a checkout should use.
 *
 * Rule: country === 'NG' -> Paystack (NGN, West Africa's primary rail).
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

  return params.country === 'NG' ? 'paystack' : 'stripe';
}
