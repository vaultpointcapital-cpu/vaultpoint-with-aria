-- ============================================================================
-- Aria Pantheon — per-position dedup state for Argus/Plutus
-- ============================================================================
-- Same shape as broker_connections.notified_health_state: a cheap
-- short-circuit so the 60s poll cycle only touches aria_findings when a
-- position's severity bucket actually changed, not on every cycle a
-- position sits unchanged at -12%. 'none' is the healthy/no-active-finding
-- baseline. See services/broker-sync/app/pantheon/argus.py and plutus.py.
-- ============================================================================

alter table public.positions
  add column argus_last_severity text not null default 'none'
    check (argus_last_severity in ('none', 'caution', 'warning', 'critical')),
  add column plutus_last_severity text not null default 'none'
    check (plutus_last_severity in ('none', 'caution', 'warning', 'critical'));

-- down
-- alter table public.positions drop column argus_last_severity, drop column plutus_last_severity;
