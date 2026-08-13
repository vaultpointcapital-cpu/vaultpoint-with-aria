-- ============================================================================
-- Aria Autonomous Trading Agent — Decision Gate manual-account alert
-- durability (extends 20260813000000_add_aria_findings.sql)
-- ============================================================================
-- The Decision Gate's manual-account alert path (app/decision_gate/service.py)
-- writes a durable aria_findings row alongside the real-time step-up/
-- Telegram challenge, via the same shared write path every other Pantheon
-- worker uses (app/pantheon/dedup.py's upsert_finding()) — so a user
-- without Telegram linked still sees the alert surfaced next time they
-- open Aria chat (src/lib/aria/findings.ts's getNewFindings() has no
-- severity filter, only status='new').
--
-- severity is always 'caution' for this source_agent, never 'warning'/
-- 'critical' — same choice Hermes already makes for its own buy_signal
-- findings, and for the same structural reason here: warning/critical
-- findings are eligible for the proactive-check cron's batched delivery
-- (src/app/api/aria/pantheon/proactive-check/route.ts), which runs on a
-- 5-30 min gate and synthesizes a narrative email/in-app message — the
-- wrong shape and far too slow for a structured, time-sensitive,
-- confirmation-required trade alert (PRD's own <30s setup-to-alert
-- latency target). Keeping this at 'caution' keeps new candidate_setups
-- alerts entirely out of that pipeline (and its
-- MESSAGE_TYPE_BY_FINDING_TYPE mapping, which has no entry for
-- 'trade_setup_alert' and is only ever indexed for warning/critical rows)
-- without needing to touch that route or its TypeScript type mapping at
-- all — the real-time channel is step-up + Telegram, this is a durable
-- record only.
-- ============================================================================

alter table public.aria_findings drop constraint aria_findings_source_agent_check;
alter table public.aria_findings
  add constraint aria_findings_source_agent_check
  check (source_agent in ('argus', 'plutus', 'hermes', 'mnemosyne', 'nike', 'themis', 'aria_scanner'));

alter table public.aria_findings drop constraint aria_findings_finding_type_check;
alter table public.aria_findings
  add constraint aria_findings_finding_type_check
  check (finding_type in (
    'loss_warning', 'profit_alert', 'buy_signal', 'portfolio_review',
    'market_update', 'risk_check', 'community_nudge', 'trade_setup_alert'
  ));
