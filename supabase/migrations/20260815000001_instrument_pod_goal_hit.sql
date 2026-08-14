-- ============================================================================
-- Value Ledger — pod_goal_hit instrumentation
-- ============================================================================
-- Closes a real gap: savings_pods.status has always permitted 'completed'
-- (20260617000000_initial_schema.sql) but nothing anywhere ever set it —
-- pods that hit their target just kept accumulating contributions, status
-- stuck at 'active' forever. This migration makes contribute_to_pod detect
-- the crossing (current_amount goes from below target to at/above target)
-- and set status='completed' in the same locked transaction, returning a
-- goal_just_hit flag so the calling route can emit a value_ledger_events
-- 'pod_goal_hit' row as a side effect.
--
-- Signature changed (return shape grew three columns) — dropped and
-- recreated rather than CREATE OR REPLACE, same reasoning
-- 20260804000000_add_money_currency_layer.sql used for its own signature
-- change: CREATE OR REPLACE can't alter a function's declared return type.
-- ============================================================================

drop function if exists public.contribute_to_pod(uuid, uuid, numeric, text, text);

create function public.contribute_to_pod(
  p_pod_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_note text default null,
  p_currency text default null
)
returns table (
  contribution_id uuid,
  new_current_amount numeric,
  goal_just_hit boolean,
  target_amount numeric,
  pod_deadline date,
  pod_created_at timestamptz
)
language plpgsql
security invoker
as $$
declare
  v_pod_status text;
  v_current_amount numeric;
  v_pod_currency text;
  v_target_amount numeric;
  v_deadline date;
  v_created_at timestamptz;
  v_contribution_id uuid;
  v_new_amount numeric;
  v_goal_just_hit boolean := false;
begin
  select status, current_amount, currency, target_amount, deadline, created_at
    into v_pod_status, v_current_amount, v_pod_currency, v_target_amount, v_deadline, v_created_at
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

  if p_currency is not null and p_currency <> v_pod_currency then
    raise exception 'Contribution currency (%) does not match pod currency (%)', p_currency, v_pod_currency
      using errcode = 'P0005';
  end if;

  insert into public.pod_contributions (pod_id, user_id, amount, note, currency)
  values (p_pod_id, p_user_id, p_amount, p_note, v_pod_currency)
  returning id into v_contribution_id;

  v_new_amount := v_current_amount + p_amount;

  -- Goal-hit transition fires only once, on the crossing itself
  -- (v_current_amount was still below target before this contribution) —
  -- a pod that was already completed before this call (shouldn't happen,
  -- contribute_to_pod is only reachable for active pods per the app
  -- layer, but guarded here regardless) never re-fires.
  if v_pod_status = 'active' and v_current_amount < v_target_amount and v_new_amount >= v_target_amount then
    v_goal_just_hit := true;
    update public.savings_pods set current_amount = v_new_amount, status = 'completed' where id = p_pod_id;
  else
    update public.savings_pods set current_amount = v_new_amount where id = p_pod_id;
  end if;

  return query select v_contribution_id, v_new_amount, v_goal_just_hit, v_target_amount, v_deadline, v_created_at;
end;
$$;

comment on function public.contribute_to_pod is
  'Atomically logs a pod contribution, updates the running total, and detects a goal-hit crossing (sets status=completed once). Row-locked to prevent concurrent-write races. Rejects a contribution whose currency does not match the pod''s own currency (no implicit conversion). goal_just_hit lets the calling route emit a value_ledger_events pod_goal_hit row (see 20260815000000_add_value_ledger.sql) as a side effect, same pattern as invalidateAriaContext.';
