# Profit-Split Billing

Status: documents the **as-built** billing mechanics as of 2026-07-23. There are two genuinely
different systems here, both called "profit share" colloquially — this doc keeps them separate on
purpose, because they move money in opposite directions.

## Two different models, not one

| | Managed Mode | Managed Accounts |
|---|---|---|
| Whose broker | User's own connected `broker_connections` | VaultPoint-custodied sub-account (`managed_accounts`) |
| Who holds the money | The user, always | VaultPoint, in a segregated sub-account |
| How VaultPoint gets paid | **Charges** the user's card for a % of Aria-attributed profit | **Withholds** its % before paying out the client's share |
| Rate | Flat `PROFIT_SHARE_PCT = 20%` for everyone | Per-tier: bronze 30% / silver 25% / gold 20% (VaultPoint's cut — lower tier costs more, matches paying less for the subscription) |
| Billing cadence | Monthly, automated (cron-driven true-up) | Client-initiated, gated by `withdrawal_window_cadence` (monthly/biweekly/on-demand per tier) |
| Payment rail | Real: Stripe off-session card charge | **Not built**: manual admin-confirmed payout only |
| Status today | Fully working, tested | Calculation + request flow built; no engine produces real P&L yet (see architecture doc) |

## Managed Mode: the working system

`src/lib/billing/profit-share.ts`, `runProfitShareForUser`:

1. For each user, sums `realized_pnl` from `signal_outcomes` joined through `signal_actions` where
   `initiated_by = 'aria'` and `action = 'executed'`, for the just-completed calendar month —
   **never trades the user placed themselves** (`initiated_by = 'user'` is explicitly excluded).
2. Idempotent by construction: checks `profit_share_charges` for an existing
   `(user_id, period_start, period_end)` row *before* computing anything, so a retried run can
   never double-bill.
3. If attributed profit is `<= 0`, records a `'skipped'` row and charges nothing — no fee on a
   losing month, ever.
4. If there's profit, charges `attributedProfit * (PROFIT_SHARE_PCT / 100)` (rounded to cents) via
   Stripe off-session, using whatever payment method is already on file.
5. **Paystack subscribers are deliberately failed, not charged** — the fee is computed in USD (from
   `realized_pnl`, USD throughout this codebase) but Paystack subscriptions are NGN, and there is no
   FX-rate source anywhere in this codebase. Rather than mischarge by an unknown rate, this fails
   loudly (`status: 'failed'`, `failure_reason` set) for a human to resolve. **This is a real gap for
   any Elite subscriber on Paystack who opts into Managed Mode** — worth a decision: add a real FX
   rate source, or restrict Managed Mode to Stripe subscribers until one exists.
6. Every outcome — already billed, no profit, no payment method, provider rejection, success — ends
   in exactly one `profit_share_charges` row. Nothing is silently dropped.

## Managed Accounts: calculation and request flow (built), payout rail (not built)

`src/lib/validations/managed-accounts.ts`, `computeAccountStats` / `computeDistributionBreakdown`,
called from `POST /api/managed-accounts/:id/withdraw`:

1. `computeAccountStats` walks every closed `managed_trades` row chronologically from
   `starting_capital`, tracking running balance, peak balance (for drawdown), and P&L accumulated
   since the last **paid** distribution's `period_end`.
2. `computeDistributionBreakdown` splits that period's gross P&L: if `<= 0`, client keeps 100% (no
   fee on a loss, same principle as Managed Mode); if positive, VaultPoint keeps `profit_split_pct`
   (the tier's rate) and the client keeps the rest, both rounded to cents.
3. This is **recomputed server-side from `managed_trades`**, never trusted from whatever the
   client's preview screen showed (`GET /api/managed-accounts/:id/withdraw/preview` shows the same
   number in advance, but the actual request route redoes the math).
4. `profit_distributions_one_per_account_per_period` (a unique constraint on
   `(managed_account_id, period_start, period_end)`) is the same idempotency guard
   `profit_share_charges` uses — a duplicate submit for the same period fails the constraint rather
   than creating a second payout obligation.
5. The request creates a `'pending'` row. **Nothing here pays anyone.** An admin, via the
   compliance dashboard (`POST /api/admin/managed-accounts/:id/distributions/:id/mark-paid`), moves
   it to `confirmed`/`paid` after sending funds through some out-of-band channel entirely outside
   this codebase (bank transfer, whatever). This is a real, working manual process — not a stub —
   it just isn't automated.

## Why this whole system currently has nothing to bill on

`computeAccountStats` reads from `managed_trades`. As covered in the architecture doc, **nothing
writes to `managed_trades`** — there's no execution engine, so real accounts have no real P&L to
compute a distribution from. This billing math is correct and ready; it has no data to run on until
the trading engine exists.

## Open decisions (not code fixes)

1. **Managed Mode + Paystack**: source a real USD/NGN rate, or restrict Managed Mode to
   Stripe-billed Elite subscribers for now.
2. **Managed Accounts payout rail**: stay manual indefinitely, or integrate a real transfer API
   (Paystack Transfers, a bank API, etc.) once volume justifies it. Manual is fine at low client
   counts; it will not scale past a handful.
3. **Statement PDFs**: `profit_distributions.statement_pdf_url` exists as a column but nothing
   generates one — `src/components/billing/profit-share-statement.tsx` renders Managed Mode
   statements in-app; no equivalent exists for Managed Accounts distributions yet.
