# Web3 Payments — PRD Status

## There is nothing to "revive"

Unlike Managed Accounts (which had real migrations, API routes, and a working onboarding flow
already built), a full search of this repository found **zero existing Web3/wallet/crypto payment
code or documentation** — no chain config, no wallet integration, no contract addresses, no prior
spec file. If a "previously parked spec" exists, it lives entirely outside this repo (Notion,
Google Docs, a conversation) and I don't have access to it.

This doc and its two companions (`wallet-integration-spec.md`, `compliance-kyc-spec.md`) are a
**fresh first draft**, written from: the existing payment-provider architecture already in this
codebase (`src/lib/billing/routing.ts`, the Stripe/Paystack/Flutterwave webhook pattern), and the
one directional hint the checklist itself gives — "likely stablecoin-focused given Nigeria/West
Africa FX volatility context." Treat every concrete recommendation below as a starting proposal to
confirm or override, not a decision already made.

## Why Web3 payments are a genuinely different risk category than the Managed Accounts placeholder
terms were

When Track B needed real numbers and none existed, deriving reasonable tier terms from the
existing Pro/Elite subscription split was a safe, low-stakes call — worst case, a profit-split
percentage gets renegotiated later.

Web3 payments are different in kind, not just degree:

- **Money-transmitter / VASP licensing risk.** Depending on exactly how funds flow (does VaultPoint
  ever hold customer crypto, even momentarily?), this can trigger Virtual Asset Service Provider
  registration requirements under Nigerian SEC rules separate from VaultPoint's existing securities
  registration, or equivalent licensing in whatever other jurisdictions get served.
- **AML/sanctions exposure is structurally different.** Card and bank rails have the processor
  (Stripe/Paystack/Flutterwave) doing KYC/AML/sanctions screening as part of onboarding a merchant
  and processing each transaction. A wallet-to-wallet crypto payment has no equivalent gatekeeper by
  default — VaultPoint would need to build or buy that screening capability itself, or accept the
  regulatory exposure of not having it.
- **Nigeria's crypto regulatory stance has been volatile.** The CBN restricted banks from servicing
  crypto exchanges in 2021 and eased that stance later; SEC Nigeria has separately issued crypto/VASP
  rules. "SEC Nigeria registration approved" (the trigger for unblocking Tracks B/C) was almost
  certainly about the Managed Accounts securities-adjacent product, not a blanket clearance to
  operate crypto payment rails — worth explicit confirmation with whoever handled that approval
  before assuming it covers this too.

None of this blocks writing the technical spec (`wallet-integration-spec.md`) — chain/wallet choice
is a product and engineering decision I can reason about the same way I did tier pricing. It does
mean `compliance-kyc-spec.md` is written as a list of **questions that need real legal answers**,
not a set of resolved requirements, the same way the Managed Accounts KYC-vendor and e-signature
decisions were left open rather than silently resolved.

## Recommended first-cut scope, if you want a narrow starting point

Given the stated FX-volatility/remittance framing, the lowest-risk useful version of this feature
is probably: accept stablecoin payment for a subscription (Pro/Elite), convert to fiat immediately
(never hold crypto on VaultPoint's own balance sheet), credit the subscription the same way a
Stripe/Paystack/Flutterwave webhook does today. That's meaningfully narrower than "wallet
integration" in the general sense (no in-app wallet, no crypto balances, no withdrawal-in-crypto
flow) and reuses the existing `resolveProvider`-style webhook-driven subscription-crediting
pattern almost exactly. See `wallet-integration-spec.md` for the concrete shape of that.
