-- ============================================================================
-- Step-Up Auth — Ticket 2: step-up initiate/confirm/status flow.
-- ============================================================================
-- The approval_id a client holds is never this table's raw id — it's a
-- signed JWT (src/lib/auth/step-up.ts) whose `sub` claim IS this row's id.
-- The JWT's signature + own exp claim guard against tampering/replay before
-- a request even reaches the DB; this table's own expires_at/status stay
-- the authoritative source of truth confirm_step_up_approval() locks and
-- mutates.
--
-- Both methods the spec's /confirm endpoint accepts are real, not stubs,
-- but bounded by what Ticket 1 actually built: 'push' is verified against
-- the raw device token captured at registration (src/lib/auth/devices.ts) —
-- a real HMAC proof-of-possession, not asymmetric per-device signing (that
-- would need a public-key registration step Ticket 1 never added). 'totp'
-- has zero enrollment infrastructure until Ticket 3 ships, so it can never
-- appear in a row's offered `methods` and any confirm attempt against it is
-- rejected as method-not-offered rather than silently faked. A user with no
-- registered device therefore has no way to ever resolve a step-up
-- challenge today — the same "real gate, not yet satisfiable by everyone"
-- trade-off already made for the Managed Accounts funding gate sitting
-- behind KYC (20260724000003_add_kyc_verifications.sql).
-- ============================================================================

create type step_up_status as enum ('pending', 'approved', 'denied', 'expired');
create type step_up_method as enum ('push', 'totp');

create table public.step_up_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  action_type text not null,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  -- What confirm() will actually accept for this approval, decided at
  -- initiate time from what's structurally available (see
  -- src/lib/auth/step-up.ts's initiateStepUp) — never edited after insert.
  methods step_up_method[] not null default '{}',
  status step_up_status not null default 'pending',
  method step_up_method,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz
);

comment on table public.step_up_approvals is
  'Step-up MFA approval requests (Step-Up Auth Ticket 2). No client insert/update/delete policy — every write goes through service-role code in src/lib/auth/step-up.ts, same pattern as user_devices and kyc_verifications.';

create index step_up_approvals_user_idx on public.step_up_approvals (user_id);
-- Supports a future cleanup/expiry-sweep job; nothing reads this yet.
create index step_up_approvals_pending_expiry_idx on public.step_up_approvals (expires_at) where status = 'pending';

alter table public.step_up_approvals enable row level security;

create policy "Users can view their own step-up approvals"
  on public.step_up_approvals for select
  using (auth.uid() = user_id);

-- Append-only resolution audit trail — one row per confirm() call that
-- actually resolves an approval (approve/deny/expire), written in the same
-- transaction as the state change below, never after.
create table public.step_up_audit_log (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.step_up_approvals(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  action_type text not null,
  resource_id text,
  status step_up_status not null,
  method step_up_method,
  created_at timestamptz not null default now()
);

comment on table public.step_up_audit_log is
  'Immutable record of every resolved step-up approval (Ticket 2). Written inside confirm_step_up_approval() alongside the status update — a crash between the two is impossible since both happen in the same Postgres function invocation/transaction. Ticket 5 (audit log + admin view) reads this table; this ticket only writes it.';

alter table public.step_up_audit_log enable row level security;

create policy "Users can view their own step-up audit entries"
  on public.step_up_audit_log for select
  using (auth.uid() = user_id);

-- Single writer for resolving an approval. Row-locked; idempotent against
-- redelivery of an already-resolved approval_id (returns the prior outcome
-- untouched rather than re-mutating or erroring, per spec); lazily expires
-- a stale pending row in place of the requested decision if its TTL has
-- already passed. The audit insert happens in the same statement sequence
-- as the status update, both inside this one function call, so they
-- commit or roll back together.
create or replace function public.confirm_step_up_approval(
  p_approval_id uuid,
  p_user_id uuid,
  p_decision step_up_status,
  p_method step_up_method
)
returns table (
  out_status step_up_status,
  out_resolved_at timestamptz,
  already_resolved boolean
)
language plpgsql
security invoker
as $$
declare
  v_status step_up_status;
  v_expires_at timestamptz;
  v_resolved_at timestamptz;
  v_action_type text;
  v_resource_id text;
begin
  select a.status, a.expires_at, a.resolved_at, a.action_type, a.resource_id
  into v_status, v_expires_at, v_resolved_at, v_action_type, v_resource_id
  from public.step_up_approvals a
  where a.id = p_approval_id and a.user_id = p_user_id
  for update;

  if not found then
    raise exception 'Step-up approval not found' using errcode = 'P0001';
  end if;

  -- Idempotent redelivery: already resolved (approved/denied/expired) —
  -- return the existing outcome untouched, never re-mutate or re-log.
  if v_status <> 'pending' then
    return query select v_status, v_resolved_at, true;
    return;
  end if;

  if v_expires_at < now() then
    update public.step_up_approvals
    set status = 'expired', resolved_at = now()
    where id = p_approval_id
    returning status, resolved_at into v_status, v_resolved_at;
  else
    update public.step_up_approvals
    set status = p_decision, method = p_method, resolved_at = now()
    where id = p_approval_id
    returning status, resolved_at into v_status, v_resolved_at;
  end if;

  insert into public.step_up_audit_log (approval_id, user_id, action_type, resource_id, status, method)
  values (p_approval_id, p_user_id, v_action_type, v_resource_id, v_status, p_method);

  return query select v_status, v_resolved_at, false;
end;
$$;

comment on function public.confirm_step_up_approval is
  'Resolves a pending step-up approval and writes its audit entry atomically. Row-locked against concurrent confirm calls for the same approval_id; idempotent against redelivery; expires a stale pending row in place of the requested decision once its TTL has passed.';
