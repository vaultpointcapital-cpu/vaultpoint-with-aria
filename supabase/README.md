# Database schema changes

**Every schema change ships as a migration file in `migrations/`. No dashboard SQL editor edits, no ad-hoc `ALTER TABLE` against live, no exceptions.**

This rule exists because it was broken before it was written: live's actual schema had drifted from every checked-in migration across nearly the entire `public` schema, and three tables (`autonomous_action_log`, `execution_authorizations`, `withdrawal_authorizations`) existed in production with zero migration coverage at all — created directly against the database, outside version control, encoding real trade-execution and withdrawal functionality this project had explicitly decided not to build. Reconciling that took a multi-phase effort (see `RUNBOOK-DB-RECONCILE.md` in this directory and migrations `20260717000000` through `20260717000005`). Don't recreate the problem.

## In practice

- Need a schema change? Write a migration file, timestamped after the current latest one (`YYYYMMDDHHMMSS_description.sql`, matching the existing files — check `migrations/` for the current tail before picking a timestamp).
- Migrations are applied to live by hand, in order, by the project owner — not by CI, not automatically on merge. Don't run `supabase db push` (or equivalent) against live yourself.
- Every PR that touches `migrations/` runs the migration dry-run CI job (`.github/workflows/migration-dry-run.yml`), which applies the full stack, in order, to a fresh database. A migration that only works against an already-partially-applied database is a bug in the migration, not something to special-case in CI.
- If a migration needs a rollback, write the down-migration alongside it in `rollbacks/` (not in `migrations/` — see that directory's files for why: the Supabase CLI applies everything in `migrations/` forward, so a "down" file placed there would run as a second forward migration instead of undoing anything).
- Before any migration touches live, take a full `pg_dump` (schema + data) first. No backup, no surgery — this tier has no point-in-time recovery, so the dump is the only rollback path if a migration goes wrong in a way its own down-migration can't cleanly undo.
