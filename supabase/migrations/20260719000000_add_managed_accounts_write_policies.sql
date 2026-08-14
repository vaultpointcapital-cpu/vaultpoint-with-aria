-- ============================================================================
-- VaultPoint Managed Accounts — fix missing INSERT/UPDATE policies
-- ============================================================================
-- Gap found while building the withdrawal flow: 20260718000004 gave
-- disclosure_views, client_authorizations, and managed_accounts SELECT
-- policies only (disclosure_views later got an UPDATE policy in
-- 20260718000005). But every onboarding/funding route
-- (POST /api/managed-accounts/disclosure-view, POST .../authorization,
-- POST /api/managed-accounts, POST .../:id/fund) writes through the
-- RLS-scoped client, not the service client — with no INSERT/UPDATE
-- policy, Postgres RLS denies those writes by default regardless of what
-- the application code checks. The whole onboarding flow as built could
-- not actually complete end-to-end in production. Shadow rehearsal of
-- 20260718000004 tested the CHECK constraints via superuser INSERT/UPDATE,
-- which bypasses RLS entirely and never would have caught this.
--
-- profit_distributions gets an INSERT policy here too, scoped via a join
-- to managed_accounts ownership (it has no user_id column of its own) —
-- needed by the withdrawal-request route being added alongside this
-- migration.
-- ============================================================================

create policy "Users can log their own disclosure views"
  on public.disclosure_views for insert
  with check (auth.uid() = user_id);

create policy "Users can sign their own authorization"
  on public.client_authorizations for insert
  with check (auth.uid() = user_id);

create policy "Users can create their own managed accounts"
  on public.managed_accounts for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own managed accounts"
  on public.managed_accounts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can request distributions on their own managed accounts"
  on public.profit_distributions for insert
  with check (
    exists (
      select 1 from public.managed_accounts
      where managed_accounts.id = profit_distributions.managed_account_id
      and managed_accounts.user_id = auth.uid()
    )
  );
