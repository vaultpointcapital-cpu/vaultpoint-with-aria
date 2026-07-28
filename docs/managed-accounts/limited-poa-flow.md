# Limited Power of Attorney — Consent & Disclosure Flow

Status: documents the **as-built** onboarding flow (`src/components/managed-accounts/onboarding-wizard.tsx`)
as of 2026-07-23.

## Flow order

```
disclosure → kyc → authorization → provision → funding → done
```

Note this is a different order than the status lifecycle in the architecture doc
(`pending_kyc → pending_authorization → ...`) — in practice, by the time a `managed_accounts` row
is created (the "provision" step), the client has *already* signed the authorization in step 3.
The row is inserted already carrying a `client_authorization_id`, so `pending_kyc` is genuinely the
first state a real row sits in, waiting for KYC to clear.

## Step 1 — Disclosure

- Client selects a Managed Tier (bronze/silver/gold) and reads `DISCLOSURE_TEXT` (risk of loss,
  drawdown policy, fee/split structure, custody statement — see that constant's own comment: this
  is placeholder copy pending real Legal-reviewed content, not final).
- On mount, `POST /api/managed-accounts/disclosure-view` logs a `disclosure_views` row with
  `viewed_at`.
- A scroll listener on the disclosure container `PATCH`es that same row with
  `scrolled_to_bottom_at` once the client scrolls to the bottom — the actual gate for enabling
  "Continue" is that this timestamp is set, not just that a view was logged. A client who opens the
  page and immediately clicks away without scrolling cannot proceed.

## Step 2 — KYC

- The account row is created here already (see note above) with `kyc_status: 'pending'`.
- This is an explicitly manual step: no KYC/sanctions-screening vendor (Persona, Onfido,
  ComplyAdvantage, etc.) is integrated. The UI tells the client this is a manual review and to wait
  for notification.
- **Important gap**: the "I've been notified my KYC is verified — continue to funding" button is
  purely client-side state (`setStep('funding')`) — it does not itself verify `kyc_status` in the
  database. It relies on the DB-level `managed_accounts_active_requires_kyc` constraint to actually
  block the account from reaching `active` if KYC genuinely isn't verified yet, but the *UI* will
  happily let a client click through to the funding step's *form* before that's true. Worth fixing:
  either re-fetch and check `kyc_status` before allowing this transition, or make the funding
  confirmation route's own failure (if it exists) surface clearly rather than letting a client fill
  out the funding form only to hit a wall.
- Nothing in this codebase can set `kyc_status` to `'verified'` automatically. Today, someone with
  DB or Table Editor access does it manually after doing identity verification themselves entirely
  outside the app.

## Step 3 — Authorization (the actual limited PoA signature)

- Client types their full legal name and checks a consent box acknowledging they've read the
  disclosure and authorize VaultPoint to trade under the stated terms.
- `POST /api/managed-accounts/authorization` records: `document_version`, `document_url` (now
  `/legal/managed-accounts-authorization-v1` — see below), `typed_legal_name`, `signed_at`
  (server-set), `ip_address`, and `signature_method` (fixed at `'checkbox_and_typed_name'`).
- **Signature method is explicitly not a substitute for a real e-signature vendor.** The
  `client_authorizations.signature_method` CHECK constraint only allows
  `'checkbox_and_typed_name'` today — there is no DocuSign/HelloSign integration, and the schema
  comment flags this as a real gap for Legal to weigh in on before this accepts real clients. This
  is a decision for you/Legal, not something resolved by this doc.
- The document the client is agreeing to (`/legal/managed-accounts-authorization-v1`) previously
  **did not exist as a page** — the signed record pointed at a 404. Fixed: that page now exists
  with placeholder-but-complete limited-PoA language (grant of authority, scope bound by tier
  policy, custody, revocation, compensation, signature) — still flagged as pending real Legal
  review, same status as the disclosure text, but no longer a dead link.

## Step 4 — Provision

- Client enters MT login/server/platform/password. `POST /api/managed-accounts` re-checks tier
  eligibility and that a non-revoked authorization exists, encrypts the MT password, and creates
  the `managed_accounts` row.
- As covered in the architecture doc: this does **not** provision a real MetaApi terminal. The
  credentials are stored encrypted; nothing deploys or connects them yet.

## Step 5 — Funding

- Client deposits capital directly into their sub-account on the broker's own platform (out of
  this app entirely — VaultPoint never receives the funds through the app), then self-reports the
  amount deposited via `POST /api/managed-accounts/:id/fund`.
- This is a self-reported confirmation, not a verified balance check (no engine syncs actual
  balance — see the architecture doc's "not built" section).

## Revocation

- `client_authorizations.revoked_at` exists as a column, but no route in this codebase sets it —
  revocation isn't wired up as a user-facing action yet, despite the disclosure/authorization text
  telling the client they can revoke at any time. Worth flagging as a real gap: the flow promises a
  right that has no working code path.

## Reconfirmation (terms-change flow)

- If a tier's terms change (an admin action, not automated), `managed_accounts.requires_disclosure_reconfirmation`
  gets flipped `true` — this is stated in the schema as intended but no code path sets it either
  (same category of gap as revocation: the *consequence* of the flag being true is fully built and
  enforced — `POST /api/managed-accounts/:id/reconfirm`, the withdrawal block — but nothing sets
  the flag true in the first place yet).
- Once true, the client must re-view the current disclosure version (scroll-to-bottom again) and
  re-sign the authorization for the current `AUTHORIZATION_DOCUMENT_VERSION` before the flag
  clears. Withdrawals are blocked until it does.

## Summary of what still needs a decision (not a code fix)

1. **E-signature vendor** — accept checkbox+typed-name as legally sufficient for a limited PoA
   under Nigerian law, or integrate a real vendor first. This is Legal's call.
2. **KYC vendor** — stay fully manual, or integrate a vendor (Persona/Onfido/ComplyAdvantage/etc.)
   before scaling past a handful of clients a human can manually verify.
3. **Real disclosure/authorization document text** — the placeholder copy needs Legal review
   before real clients rely on it.

## Concrete follow-up work (not decisions, just unbuilt)

- Wire up `client_authorizations.revoked_at` to an actual revoke action.
- Wire up something that sets `requires_disclosure_reconfirmation = true` when tier terms change.
- Make the KYC step's "continue" actually check `kyc_status` server-side before letting a client
  proceed to fill out the funding form.
