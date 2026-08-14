-- ============================================================================
-- VaultPoint — Fix handle_new_user() to populate email
-- ============================================================================
-- Found during the Part 3 schema-vs-code rehearsal (seeding a test user
-- into the reconciled shadow project): the checked-in trigger function
-- from 20260617000000_initial_schema.sql only inserts (id, full_name)
-- into public.users, never email — even though public.users.email is
-- NOT NULL (preserved from live during the table reconciliation, see
-- 20260717000001_reconcile_remaining_tables_with_live.sql). Every new
-- signup against the reconciled schema violates that NOT NULL constraint.
--
-- This is function/trigger drift, not table drift — a category the
-- earlier schema-vs-schema reconciliation work didn't check (it compared
-- CREATE TABLE statements, not CREATE FUNCTION/TRIGGER ones). Live's own
-- actual handle_new_user() (whatever out-of-band process created it) is
-- already correct — it inserts (id, email, full_name) with an
-- `on conflict (id) do nothing` safety net. This migration brings the
-- checked-in version in line with what live already correctly does.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, email, full_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path to '';
