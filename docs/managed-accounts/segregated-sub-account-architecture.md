# Segregated Sub-Account Architecture

Status: documents the **as-built** architecture as of 2026-07-23. Written from the actual schema
and code, not a greenfield design — where something is a real gap rather than a design choice,
it's called out explicitly under "Not built."

## Why this is a separate model from `broker_connections`

`broker_connections` (used by Portfolio tracking, Signal Mode, Managed Mode) assumes the user
pasted in their **own** read-only-by-default API key — the RLS model and `is_read_only` invariant
are built around that trust boundary (see `20260718000000_add_signal_mode.sql`).

A Managed Account is the opposite trust model: VaultPoint is *itself* the custodian, provisioning
and holding credentials to a sub-account it trades on the client's behalf. Overloading
`broker_connections`' semantics for that would be wrong, so `managed_accounts` is its own table
with its own encrypted-credential columns (same AES-256-GCM pattern, different table).

## Table map

| Table | Purpose | Written by |
|---|---|---|
| `disclosure_views` | Audit log: every time a client views the risk disclosure, with a `scrolled_to_bottom_at` timestamp gating onboarding progression | `POST /api/managed-accounts/disclosure-view` |
| `client_authorizations` | The signed limited PoA record — document version, document URL, typed legal name, signed timestamp, IP, revocation timestamp | `POST /api/managed-accounts/authorization` |
| `managed_accounts` | One row per client sub-account: tier, terms (profit split / drawdown cap / withdrawal cadence), KYC status, encrypted broker credentials, status, balances | `POST /api/managed-accounts` (create), various routes (status transitions) |
| `managed_trades` | Read-only trade log shown on the client dashboard | **Nothing — see "Not built" below** |
| `profit_distributions` | One row per (account, withdrawal period) — the payout ledger | `POST /api/managed-accounts/:id/withdraw` (create), admin compliance dashboard (confirm/mark paid) |
| `managed_account_notifications` | In-app notifications tied to an account (onboarding milestones, distribution requests, etc.) | `src/lib/managed-accounts/notifications.ts` |

## Isolation model

- **Row-level security**: every table restricts `select` to `auth.uid() = user_id` (directly, or via
  a join back to `managed_accounts.user_id` for `managed_trades`/`profit_distributions`). No client
  insert/update/delete policy exists on any of these tables — all writes go through server-side
  API routes using the service-role client, which apply their own authorization checks (ownership,
  tier eligibility, status preconditions) before writing.
- **Credential isolation**: each `managed_accounts` row carries its own encrypted MT credentials
  (`encrypted_mt_password`/`mt_password_iv`) and its own `metaapi_account_id`/`metaapi_region` —
  never shared with or derived from any `broker_connections` row, even if the same person has both.
- **`is_admin`**: a new `users.is_admin` boolean gates the compliance dashboard. Set only via the
  Supabase Table Editor directly — no self-service UI grants it, deliberately (same pattern as
  `academy_videos`' founder-managed content).

## DB-enforced acceptance criteria (not just app-code checks)

Two `CHECK` constraints on `managed_accounts` are the actual enforcement boundary, independent of
whether any application code path remembers to verify these:

```sql
constraint managed_accounts_funding_requires_authorization
  check (status not in ('pending_funding', 'active') or client_authorization_id is not null)
constraint managed_accounts_active_requires_kyc
  check (status not in ('pending_funding', 'active') or kyc_status = 'verified')
```

A row can sit in `pending_kyc` or `pending_authorization` with no signed authorization and no
verified KYC — but it is **physically impossible**, at the database level, for it to reach
`pending_funding` or `active` without both. This is the load-bearing safety property of the whole
product and it does not depend on any route remembering to check it.

## Status lifecycle

```
pending_kyc → pending_authorization → pending_funding → active → closed
```

(Authorization is actually signed *before* provisioning in the current onboarding wizard order —
disclosure → KYC → authorization → provision → funding — so in practice a row is created already
carrying a `client_authorization_id`, and `pending_kyc` is the state a real row starts in and
waits in until KYC clears.)

## What's real vs. what's audit-trail-only right now

**Real, enforced, working:**
- Onboarding gating (disclosure viewed → authorization signed → account created)
- DB-level authorization/KYC gates before funding/active
- Withdrawal window cadence enforcement (`next_withdrawal_window_date` checked server-side)
- Reconfirmation flow: `requires_disclosure_reconfirmation` blocks withdrawal until a client
  re-accepts changed terms
- Manual payout tracking: an admin marks a `profit_distributions` row `confirmed`/`paid` via the
  compliance dashboard after sending funds through an out-of-band channel (bank transfer, etc.)

**Not built — this is the headline gap, not a minor TODO:**
- **No trade execution engine exists for Managed Accounts.** `POST /api/managed-accounts` creates
  the row with encrypted MT credentials but *deliberately does not call MetaApi's provisioning
  API* — the code comment is explicit: "requires either extending the Python broker-sync poller to
  also scan `managed_accounts`... or a dedicated endpoint, neither of which exists yet." The
  broker-sync service's poll cycle (`sync_service.py`) only ever queries `broker_connections`, never
  `managed_accounts`.
- Following from that: `managed_trades` has **no writer anywhere in the codebase**. Nothing
  provisions the MetaApi terminal, nothing places a trade, nothing syncs positions or balance.
- Practical consequence: a client who completes the *entire* onboarding flow today — disclosure,
  KYC, signed authorization, MT credentials, funding confirmation — ends up with an `active`
  account and encrypted credentials sitting in the database, but VaultPoint is not actually trading
  anything, monitoring the account, or updating `current_balance`. The product looks complete
  end-to-end in the UI; the trading engine behind "VaultPoint discretionarily trades your capital"
  does not exist.
- No automated payout rail (bank transfer API, broker withdrawal API) — payouts are entirely
  manual/self-reported through the compliance dashboard today.

## What building the trading engine would actually require

Not attempted here — this is a scoping note, not an implementation, since it's a meaningful chunk
of new backend work:

1. Extend `sync_service.py` (or add a parallel poller) to provision (`MetaTraderClient.provision()`
   already exists and does real create+deploy+poll-until-CONNECTED — it's just never called for
   `managed_accounts` rows) and then periodically sync balance/positions into `managed_trades` and
   `managed_accounts.current_balance`.
2. A discretionary-trading decision engine — this is the "Aria Managed Mode spec" territory in the
   next doc, but note Managed Mode's engine (`app/managed_mode.py`) trades a **user's own** signal
   feed on their **own connected broker**; a Managed Account has no equivalent signal source or
   decisioning logic defined anywhere yet. This needs its own design, not a reuse of Managed Mode's.
3. A real payout rail if manual bank transfers don't scale past early clients.
