-- ============================================================================
-- VaultPoint — restore positions to read-only for users
-- ============================================================================
-- Security audit finding (Week 3 RLS review): 20260617000000_initial_schema.sql
-- explicitly created positions as SELECT-only for users ("read-only for
-- users (written by service role from FastAPI poller)", policy
-- positions_select_own) -- correct, since positions is meant to be a
-- durable mirror of what the broker actually reports, upserted every 60s
-- by the broker-sync service's service-role client, never user-editable.
--
-- Live (and shadow) currently instead have a FOR ALL policy named "Users
-- manage own positions" granting full INSERT/UPDATE/DELETE, with NO
-- migration anywhere in this repo that created it -- the same class of
-- out-of-band, undocumented change as the execution_authorizations/
-- withdrawal_authorizations tables removed in
-- 20260717000002_drop_unlaunched_execution_tables.sql, except this one
-- widened access instead of adding unused tables.
--
-- Verified safe to narrow back down: grepped every Next.js API route for
-- any `.from('positions')` call using the RLS-scoped (non-service-role)
-- client -- the only two calls (src/app/api/portfolio/route.ts,
-- src/app/api/aria/chat/route.ts) are both read-only .select() calls.
-- Nothing in the app ever writes to positions except sync_service.py's
-- service-role client, which bypasses RLS entirely and is unaffected by
-- this change.
--
-- Impact of the drift while it existed: a user could use their own JWT
-- to call Supabase's REST API directly (bypassing the Next.js app
-- entirely) and insert/modify/delete their own positions rows --
-- fabricating fake portfolio data that would then feed into their own
-- net-worth display, price/P&L alerts, and Aria's portfolio context.
-- Same-user-only impact (RLS still correctly scoped to auth.uid() =
-- user_id even under the broadened policy), not a cross-user exposure,
-- but genuinely unnecessary attack surface for data that's supposed to
-- be broker-sync's exclusive source of truth.
-- ============================================================================

drop policy if exists "Users manage own positions" on public.positions;

-- 20260617000000_initial_schema.sql already creates positions_select_own
-- on a fresh database; this migration's real job on a genuinely-drifted
-- live/shadow is dropping the undocumented FOR ALL policy above. Drop
-- first so this is idempotent either way, rather than assuming which
-- state it's running against (a fresh sequential apply — e.g. CI's
-- migration dry-run — has both policies present at this point, which
-- an unconditional CREATE POLICY can't handle).
drop policy if exists "positions_select_own" on public.positions;

create policy "positions_select_own" on public.positions
  for select using (auth.uid() = user_id);
