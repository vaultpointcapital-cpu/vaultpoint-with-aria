-- ============================================================================
-- KYC Verification module (World B — isolated identity module, buildable
-- and testable now, not wired to accept real client PII or to make
-- Managed Accounts launchable). See docs/managed-accounts/03-kyc-verification.md
-- for the full spec and the World A / World B distinction.
--
-- Closes the concrete gap flagged on managed_accounts.kyc_status's own
-- comment (20260718000004_add_managed_accounts.sql): "nothing in this
-- codebase can set it to 'verified' automatically yet." This migration
-- adds the audit-trail table; the writer that actually flips kyc_status
-- lives in src/lib/kyc/verification-state.ts, invoked only from
-- service-role contexts (the vendor webhook routes), never from a client
-- request — mirrors how billing_webhook_events is the single source of
-- truth for subscription state, not a client-supplied field.
-- ============================================================================

create type kyc_vendor as enum ('verifyme', 'onfido');
create type kyc_state as enum (
  'not_started', 'pending', 'processing', 'verified', 'rejected', 'expired', 'error'
);

create table public.kyc_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  managed_account_id uuid references public.managed_accounts(id) on delete cascade,
  vendor kyc_vendor not null,
  state kyc_state not null default 'not_started',
  -- Vendor-side applicant/check id only — never a raw BVN/NIN/passport
  -- number or document image reference. See result_summary below.
  vendor_ref text,
  -- Normalized {checks_passed, reasons[]} shape only — no raw vendor
  -- payloads, no document images, no government identifiers. Scrubbed
  -- before insert by the webhook handler, not by a DB constraint (a
  -- CHECK can't verify "this JSON contains no PII"), so
  -- src/lib/kyc/verification-state.ts is the only intended writer.
  result_summary jsonb,
  failure_reason text,
  submitted_at timestamptz,
  decided_at timestamptz,
  -- Re-verification horizon — an expired row must fail the funding gate
  -- even if state is still 'verified'. Actual interval is a
  -- compliance/counsel decision (spec §9), not hardcoded here.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.kyc_verifications is
  'Audit trail of every KYC verification attempt. managed_accounts.kyc_status stays the fast/denormalized gate the CHECK constraint reads; this table is the source of truth it gets synced from — never the reverse.';

-- One active/authoritative verification per managed account at a time —
-- prevents a second vendor flow from racing an in-flight one for the
-- same account.
create unique index one_active_kyc_per_account
  on public.kyc_verifications (managed_account_id)
  where state in ('pending', 'processing', 'verified');

create index kyc_user_idx on public.kyc_verifications (user_id);
create index kyc_vendor_ref_idx on public.kyc_verifications (vendor, vendor_ref);

alter table public.kyc_verifications enable row level security;

-- Clients may read their own rows only. No client insert/update/delete —
-- state transitions are service-role only (webhook handlers + the
-- server-side funding gate), per spec §4. This is the actual enforcement
-- point: even if application code had a bug that tried to let a client
-- write here, RLS would still refuse it.
create policy "Users can view their own KYC verifications"
  on public.kyc_verifications for select
  using (auth.uid() = user_id);

-- Append-only audit log of every inbound webhook decision, independent
-- of kyc_verifications' current-state row — the defense file if a client
-- disputes a verification outcome (spec §7). Mirrors the
-- billing_webhook_events idempotency pattern (20260724000002) but kept
-- as its own table since it's a different domain and this one is
-- intentionally never pruned/overwritten.
create table public.kyc_webhook_events (
  id uuid primary key default gen_random_uuid(),
  vendor kyc_vendor not null,
  -- The vendor's event/delivery id — idempotency key alongside vendor.
  event_id text not null,
  event_type text not null,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  -- Normalized, PII-scrubbed payload only (see kyc_verifications.result_summary comment).
  normalized_payload jsonb,
  received_at timestamptz not null default now(),
  constraint kyc_webhook_events_unique_delivery unique (vendor, event_id)
);
comment on table public.kyc_webhook_events is
  'Append-only. No update/delete policy for any role except the status column, which the webhook handler flips processing->completed|failed for retry-after-failure idempotency (same reasoning as billing_webhook_events).';

alter table public.kyc_webhook_events enable row level security;
-- No select/insert/update policy for authenticated users at all —
-- clients never see raw webhook deliveries, only their own
-- kyc_verifications summary rows. Service role bypasses RLS by design.
