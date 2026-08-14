-- ============================================================================
-- Managed Trader Pathway, Sprint 2 — extends the Sprint 1 schema
-- (20260725000000_add_managed_trader_pathway.sql) to support the actual
-- questionnaire fields, and generalizes the existing KYC module (World B,
-- 20260724000003_add_kyc_verifications.sql — originally scoped to
-- Managed Accounts clients only) so trader identity verification (PRD
-- questionnaire Section A.4/A.5 — government ID + sanctions check)
-- reuses it instead of new ad-hoc upload infra.
-- ============================================================================

-- Questionnaire fields with nowhere to live in the Sprint 1 schema.
-- trailing_90d_return / max_drawdown stay as-is (Sprint 1) — this
-- codebase has no historical equity-snapshot data anywhere to compute
-- them from yet, so they're left null at application time rather than
-- faked from a self-reported number (the questionnaire explicitly
-- expects these "auto-pulled from broker sync", not typed in).
alter table public.managed_traders
  add column strategy_description text,
  add column has_managed_funds_before boolean,
  add column has_managed_funds_before_explanation text,
  -- Section D.16/D.17 — both "must check" hard gates per the
  -- questionnaire. Storing the confirmation timestamp (not just a
  -- boolean) mirrors disclosure_views.scrolled_to_bottom_at's pattern
  -- (20260718000004_add_managed_accounts.sql) — an auditable "when",
  -- not just a flag.
  add column understands_trade_only_confirmed_at timestamptz,
  add column agrees_to_audit_logging_confirmed_at timestamptz;

-- Generalize kyc_verifications to also cover trader applications.
alter table public.kyc_verifications
  add column managed_trader_id uuid references public.managed_traders(id) on delete cascade;

-- Exactly one subject per verification — a KYC row is either for a
-- Managed Accounts client or a Managed Trader Pathway applicant, never
-- both, never neither. Safe to add as NOT VALID-free (table is empty in
-- both shadow and live as of this migration).
alter table public.kyc_verifications
  add constraint kyc_verifications_exactly_one_subject
  check (((managed_account_id is not null)::int + (managed_trader_id is not null)::int) = 1);

-- Mirrors one_active_kyc_per_account exactly, for the trader side of the
-- same table.
create unique index one_active_kyc_per_trader
  on public.kyc_verifications (managed_trader_id)
  where state in ('pending', 'processing', 'verified');

comment on column public.kyc_verifications.managed_account_id is
  'Set when this verification is for a Managed Accounts client. Exactly one of this and managed_trader_id must be non-null — see kyc_verifications_exactly_one_subject.';
comment on column public.kyc_verifications.managed_trader_id is
  'Set when this verification is for a Managed Trader Pathway applicant (PRD questionnaire Section A.4/A.5). Exactly one of this and managed_account_id must be non-null.';
