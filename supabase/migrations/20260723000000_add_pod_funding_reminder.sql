-- ----------------------------------------------------------------------------
-- savings_pods.funding_reminder
-- Day 9 UI/UX polish sprint: the "Funding Rule" step of the pod creation
-- wizard. This is an informational reminder preference ONLY — it does not
-- move money or schedule any automated contribution. There is no execution
-- engine reading this column; actual recurring auto-funding (real broker/
-- bank transfers on a schedule) is a materially different, much larger
-- feature (scheduled money movement, authorization, failure handling) that
-- is explicitly NOT built here and should be its own ticket.
-- ----------------------------------------------------------------------------
alter table public.savings_pods
  add column funding_reminder text
    check (funding_reminder in ('weekly', 'biweekly', 'monthly'));
