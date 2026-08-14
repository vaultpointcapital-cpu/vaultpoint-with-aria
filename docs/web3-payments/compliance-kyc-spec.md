# Web3 Payments — Compliance & KYC

Status: this is a list of **questions that need real legal/compliance answers**, not a resolved
spec. Nothing here should be treated as "decided" the way the finalized Managed Accounts tier
percentages were — crypto AML/licensing exposure is a different risk category (see
`prd-revival.md`'s reasoning), and I'm not qualified to resolve it by inference the way "what
should the profit split be, given the existing subscription pricing" was.

## Why this can't just reuse the card/bank rail compliance model

Stripe, Paystack, and Flutterwave each independently perform merchant KYC, cardholder/payer
verification, and transaction-level fraud/AML screening as part of processing every payment —
VaultPoint inherits that screening for free by using them. A wallet-to-wallet stablecoin payment
has no equivalent built-in gatekeeper. Whatever screening happens, VaultPoint (or a partner
processor acting on VaultPoint's behalf — see the off-ramp discussion in
`wallet-integration-spec.md`) has to actually provide it, or knowingly accept the exposure of not
having it.

## Open questions, grouped by who needs to answer them

### For Legal / compliance counsel

1. **Does accepting stablecoin payment (with immediate conversion to fiat, never holding crypto)
   require VASP registration in Nigeria**, separate from the SEC securities registration that
   unblocked Managed Accounts? These are very likely different regulatory regimes even though both
   sit under "financial services in Nigeria."
2. **Does the SEC Nigeria approval that unblocked this checklist actually cover Web3 payments at
   all**, or was it specifically scoped to the Managed Accounts product? Worth confirming directly
   with whoever handled that approval rather than assuming.
3. **What KYC is required of a subscriber paying by stablecoin**, versus one paying by card? If the
   answer is "the same KYC as any other subscriber" (i.e., none beyond normal account signup today),
   that's a materially simpler compliance posture than requiring wallet-address verification or
   source-of-funds documentation — but this needs an actual answer, not an assumption in either
   direction.
4. **Sanctions/wallet-screening obligations** — is VaultPoint (or its off-ramp partner) required to
   screen the *sending* wallet address against sanctions lists (OFAC, etc.) before accepting a
   payment? Many jurisdictions' crypto AML rules do require this even for a receive-only flow.

### For whoever picks the off-ramp partner (see `wallet-integration-spec.md`)

5. Does the chosen off-ramp/conversion partner already provide wallet-address sanctions screening
   and transaction monitoring as part of their service? If yes, several of the questions above may
   already be answered by "we use a partner who is themselves licensed/compliant for this," the
   same way VaultPoint doesn't independently KYC every Stripe cardholder today.
6. Does the partner require VaultPoint to collect and pass through any subscriber information
   (name, ID) as part of their own compliance obligations? This determines whether a "pay with
   crypto" flow needs its own data-collection step beyond what account signup already collects.

### For product/business

7. Is this even worth building before the questions above are answered, given the existing
   Paystack/Flutterwave rails already serve Nigeria and West Africa? The stated motivation is
   FX-volatility hedging for the *user*, not a payment-rail gap VaultPoint currently has — worth
   confirming this is actually a requested feature versus a "would be nice" before investing further
   compliance/legal review into it.

## What NOT to do while these are open

- Do not build or ship any Web3 payment acceptance flow before question 1-4 have real answers — this
  is the same category of decision as the Managed Accounts KYC-verification gate, and just like
  that gate, it should not be silently bypassed or assumed-fine to unblock a checklist item.
- Do not assume "we already have SEC approval" extends to this without explicit confirmation
  (question 2) — conflating two different regulatory approvals is exactly the kind of mistake that
  causes real problems later.
