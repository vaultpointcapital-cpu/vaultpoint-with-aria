-- ============================================================================
-- DOWN migration for 20260717000002_drop_unlaunched_execution_tables.sql
-- ============================================================================
-- Not in supabase/migrations/, run manually only — same rule as the other
-- rollback files in this directory. Recreates all three tables exactly as
-- they existed in live at the time of the reconciliation's schema dump
-- (structure only — they had 0 rows, so there is no data to restore here;
-- if that's ever untrue, restore from the pre-surgery full pg_dump backup
-- instead, which is the authoritative source for data, not this file).
-- ============================================================================

create table public.autonomous_action_log (
    id uuid default gen_random_uuid() not null,
    user_id uuid not null,
    action_type text not null,
    authorization_id uuid not null,
    payload jsonb not null,
    triggered_by text default 'aria'::text,
    result_status text not null,
    created_at timestamp with time zone default now(),
    constraint autonomous_action_log_action_type_check check ((action_type = any (array['trade_execute'::text, 'withdrawal'::text, 'deposit'::text]))),
    constraint autonomous_action_log_result_status_check check ((result_status = any (array['success'::text, 'failed'::text, 'blocked'::text])))
);
alter table only public.autonomous_action_log add constraint autonomous_action_log_pkey primary key (id);
alter table only public.autonomous_action_log add constraint autonomous_action_log_user_id_fkey foreign key (user_id) references public.users(id);
alter table public.autonomous_action_log enable row level security;
create policy "Users can view own action log" on public.autonomous_action_log for select using ((auth.uid() = user_id));

create table public.execution_authorizations (
    id uuid default gen_random_uuid() not null,
    user_id uuid not null,
    broker_connection_id uuid not null,
    status text default 'active'::text,
    allowed_assets text[] not null,
    min_confluence_score numeric not null,
    max_risk_pct_per_trade numeric not null,
    max_concurrent_positions integer not null,
    daily_loss_circuit_breaker_pct numeric not null,
    created_at timestamp with time zone default now(),
    last_confirmed_at timestamp with time zone not null,
    expires_at timestamp with time zone,
    constraint execution_authorizations_status_check check ((status = any (array['active'::text, 'paused'::text, 'revoked'::text])))
);
alter table only public.execution_authorizations add constraint execution_authorizations_pkey primary key (id);
alter table only public.execution_authorizations add constraint execution_authorizations_broker_connection_id_fkey foreign key (broker_connection_id) references public.broker_connections(id);
alter table only public.execution_authorizations add constraint execution_authorizations_user_id_fkey foreign key (user_id) references public.users(id);
alter table public.execution_authorizations enable row level security;
create policy "Users can manage own execution authorizations" on public.execution_authorizations using ((auth.uid() = user_id));
create policy "Users can view own execution authorizations" on public.execution_authorizations for select using ((auth.uid() = user_id));

create table public.withdrawal_authorizations (
    id uuid default gen_random_uuid() not null,
    user_id uuid not null,
    destination_type text not null,
    destination_ref text not null,
    auto_withdraw_enabled boolean default false,
    trigger_type text not null,
    threshold_amount numeric,
    schedule_cron text,
    otp_confirmed_at timestamp with time zone not null,
    cooling_off_until timestamp with time zone,
    status text default 'active'::text,
    created_at timestamp with time zone default now(),
    constraint withdrawal_authorizations_destination_type_check check ((destination_type = any (array['bank'::text, 'wallet'::text]))),
    constraint withdrawal_authorizations_status_check check ((status = any (array['active'::text, 'paused'::text, 'revoked'::text]))),
    constraint withdrawal_authorizations_trigger_type_check check ((trigger_type = any (array['threshold'::text, 'schedule'::text])))
);
alter table only public.withdrawal_authorizations add constraint withdrawal_authorizations_pkey primary key (id);
alter table only public.withdrawal_authorizations add constraint withdrawal_authorizations_user_id_fkey foreign key (user_id) references public.users(id);
alter table public.withdrawal_authorizations enable row level security;
create policy "Users can manage own withdrawal authorizations" on public.withdrawal_authorizations using ((auth.uid() = user_id));
create policy "Users can view own withdrawal authorizations" on public.withdrawal_authorizations for select using ((auth.uid() = user_id));
