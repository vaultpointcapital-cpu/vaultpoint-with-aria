# Wallet Integration — Technical Spec (Proposal)

Status: first-draft technical proposal, no prior spec existed to build on (see `prd-revival.md`).
Scoped to the narrow "accept a stablecoin payment for a subscription" version, not a general
in-app wallet/custody feature — see that doc's "recommended first-cut scope" for why.

## Recommendation: non-custodial, deposit-address-per-payment, convert-immediately

VaultPoint never holds customer crypto on its own balance sheet, even momentarily. The flow is:

1. Client picks "Pay with crypto" at checkout, sees a subscription price in a stablecoin.
2. Backend generates (or reuses, from a pool) a one-time deposit address and amount, same shape as
   how Stripe/Paystack/Flutterwave checkout sessions work today (`resolveProvider` picks the
   provider; this would be a fourth `payment_provider` value, `'web3'` or similar).
3. Client sends the stablecoin payment from their own wallet (MetaMask, Trust Wallet, etc. — no
   wallet connection/signing integration needed for this narrow flow, just "send X to this
   address," the same UX as any crypto payment processor's checkout page).
4. A watcher process confirms the on-chain transaction (amount + address + sufficient
   confirmations), converts to fiat via an off-ramp partner (see below), and only then fires the
   same "subscription activated" logic every other webhook handler already triggers
   (`syncUserSubscriptionTier`, per the existing Stripe/Paystack/Flutterwave pattern).

This deliberately avoids: an in-app wallet, VaultPoint custody of crypto balances, and a
withdraw-to-wallet flow — all of which are separate, larger, higher-risk features not implied by
"accept payment in stablecoin for FX-volatility reasons."

## Chain/asset recommendation: USDT on Tron (TRC-20) as the first and default option

- **Why stablecoin-only, no volatile assets (BTC/ETH)**: the stated use case is hedging Naira FX
  volatility for a subscription payment, not speculative crypto exposure. Accepting BTC/ETH would
  require VaultPoint to either hold price risk between receipt and conversion, or add real-time
  price-quote/slippage handling for zero benefit to this use case.
- **Why Tron/TRC-20 over an EVM chain for the first integration**: TRC-20 USDT has near-zero
  transaction fees (~$1 or less) versus Ethereum mainnet gas fees that can exceed the transaction
  value itself for a small subscription payment, and TRC-20 USDT is the dominant stablecoin rail
  for exactly this remittance/FX-hedge use case across Nigeria and West Africa already — this
  matches existing user behavior rather than asking users to adopt an unfamiliar chain.
- **Second option worth adding once the first is proven**: USDC on Base (Coinbase's L2) — also
  low-fee, and Coinbase's own on/off-ramp infrastructure (Coinbase Commerce or similar) could
  simplify the "convert immediately" step below versus building custom Tron infrastructure.
- **Not recommended for v1**: any BTC/ETH mainnet option (fee/volatility reasons above), any chain
  without a mature stablecoin off-ramp partner serving Nigeria specifically.

## Off-ramp / conversion partner — needs a real decision, not resolved here

"Convert immediately" requires an actual liquidity/off-ramp provider. Candidates worth evaluating
(not vetted here — this needs real due diligence, pricing comparison, and compliance review, not a
default pick):

- A dedicated crypto payment processor with Nigeria payout support (e.g. one that settles directly
  to a Nigerian bank account in Naira) — lowest integration effort, they handle the on-chain watcher
  and conversion, VaultPoint just gets a webhook, closest to how Stripe/Paystack/Flutterwave already
  work.
- Building the on-chain watcher in-house (via a node provider like Alchemy/QuickNode for Tron/Base)
  plus a separate liquidity provider for the fiat conversion — more engineering effort, more
  control, more compliance surface VaultPoint owns directly.

The first path (a processor that already handles compliance/conversion/payout as a service) is very
likely the right starting point given VaultPoint has no existing crypto-specific compliance
infrastructure — it pushes most of `compliance-kyc-spec.md`'s open questions onto a partner who
already has answers, rather than VaultPoint building that capability from scratch for a first
launch.

## Schema shape (consistent with the existing provider pattern)

```sql
-- Extends the existing pattern from 20260721000001_restore_flutterwave_payment_provider.sql
alter table public.subscriptions
  drop constraint if exists subscriptions_payment_provider_check;
alter table public.subscriptions
  add constraint subscriptions_payment_provider_check
  check (payment_provider in ('stripe', 'paystack', 'flutterwave', 'web3'));
```

A new `src/app/api/webhooks/web3/route.ts` (or the off-ramp partner's equivalent) following the
exact shape of `src/app/api/webhooks/flutterwave/route.ts`: verify the provider's signature/webhook
authenticity, call `syncUserSubscriptionTier`, `if (error) throw error` on every DB write — same
rules already documented in this codebase's existing webhook handlers, not a new pattern.

## Explicitly out of scope for this spec

- In-app wallet creation/connection (WalletConnect, MetaMask browser extension integration)
- VaultPoint holding any crypto balance, even transiently, beyond confirmation latency
- Withdrawal/payout in crypto (this is payment collection only, not disbursement)
- Any Managed Accounts connection — profit distributions to clients staying in fiat is a separate,
  unrelated decision from how a subscription gets paid for
