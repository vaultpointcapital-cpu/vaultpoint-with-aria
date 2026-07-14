-- ============================================================================
-- VaultPoint — Atomic Pod Contribution Function
-- Sprint 1-2 hardening (pulled forward from a Sprint 9 TODO)
-- ============================================================================
-- Wraps the contribution insert + pod total update in a single Postgres
-- function so both writes succeed or fail together. Called via
-- supabase.rpc('contribute_to_pod', {...}) instead of two separate client
-- calls — closes the atomicity gap noted in
-- src/app/api/pods/[id]/contribute/route.ts.
-- ============================================================================

create or replace function public.contribute_to_pod(
  p_pod_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_note text default null
)
returns table (
  contribution_id uuid,
  new_current_amount numeric
)
language plpgsql
security invoker -- runs as the calling user, so RLS still applies
as $$
declare
  v_pod_status text;
  v_current_amount numeric;
  v_contribution_id uuid;
  v_new_amount numeric;
begin
  -- Lock the pod row for the duration of this transaction to prevent a
  -- race condition if two contributions land at the exact same moment.
  select status, current_amount into v_pod_status, v_current_amount
  from public.savings_pods
  where id = p_pod_id and user_id = p_user_id
  for update;

  if v_pod_status is null then
    raise exception 'Pod not found or access denied' using errcode = 'P0001';
  end if;

  if v_pod_status = 'archived' then
    raise exception 'Cannot contribute to an archived pod' using errcode = 'P0002';
  end if;

  if p_amount <= 0 then
    raise exception 'Contribution amount must be positive' using errcode = 'P0003';
  end if;

  insert into public.pod_contributions (pod_id, user_id, amount, note)
  values (p_pod_id, p_user_id, p_amount, p_note)
  returning id into v_contribution_id;

  v_new_amount := v_current_amount + p_amount;

  update public.savings_pods
  set current_amount = v_new_amount
  where id = p_pod_id;

  return query select v_contribution_id, v_new_amount;
end;
$$;

comment on function public.contribute_to_pod is
  'Atomically logs a pod contribution and updates the pod running total. Row-locked to prevent concurrent-write races.';
