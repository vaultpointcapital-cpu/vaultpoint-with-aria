"""Portfolio Risk Aggregator — book resolution, shared by the aggregator
job (service.py) and Decision Gate's gate checks (gate_check.py).

Scoping key is (book_type, book_scope_id), not book_type alone — a
single global 'self_directed' bucket would net one user's JPY shorts
against an unrelated user's JPY longs, which isn't real concentration
risk. See supabase/migrations/20260818000000_add_portfolio_risk_aggregator.sql's
header comment for the full rationale.

Unlike decision_gate/service.py's _get_target_accounts() (which filters
to broker='metatrader' only, since that's the only broker this pipeline
currently routes trades to), this module deliberately does NOT filter by
broker — a book's currency/asset exposure spans every connected broker
(crypto exposure on Bybit matters for concentration math just as much as
an FX position on MT5), even though only MetaTrader positions can
currently be auto-traded against.
"""

import asyncio
from dataclasses import dataclass

# Track A (VaultPoint's own prop capital) is one pool, not per-user — a
# fixed sentinel rather than a real users.id, since no prop capital is
# provisioned anywhere in this codebase yet (this path is a no-op by
# construction until it is).
PROP_BOOK_SCOPE_ID = "00000000-0000-0000-0000-000000000001"


@dataclass(frozen=True)
class BookMembership:
    book_type: str  # 'self_directed' | 'managed_client' | 'prop'
    book_scope_id: str
    connection_ids: list[str]


def resolve_book(account: dict) -> tuple[str, str]:
    """`account` is the same dict shape decision_gate/service.py's
    _get_target_accounts() already produces — a broker_connections row
    (+ account_type='broker_connection', + book) or a managed_sub_accounts
    row (+ account_type='managed_sub_account', + trader_id)."""
    if account["account_type"] == "managed_sub_account":
        return "managed_client", account["trader_id"]
    if account.get("book") == "prop":
        return "prop", PROP_BOOK_SCOPE_ID
    return "self_directed", account["user_id"]


async def enumerate_active_books(supabase) -> list[BookMembership]:
    connections_result = await asyncio.to_thread(
        lambda: supabase.table("broker_connections").select("id, user_id, book").neq("health", "closed").execute()
    )
    connections = connections_result.data or []

    sub_accounts_result = await asyncio.to_thread(
        lambda: supabase.table("managed_sub_accounts")
        .select("id, trader_id, broker_connection_id")
        .eq("status", "active")
        .execute()
    )
    sub_accounts = sub_accounts_result.data or []

    # A broker_connection claimed by an active managed_sub_accounts row is
    # grouped under managed_client, never counted twice under
    # self_directed too.
    claimed_connection_ids: set[str] = set()
    trader_connection_ids: dict[str, list[str]] = {}
    for sa in sub_accounts:
        claimed_connection_ids.add(sa["broker_connection_id"])
        trader_connection_ids.setdefault(sa["trader_id"], []).append(sa["broker_connection_id"])

    self_directed_by_user: dict[str, list[str]] = {}
    prop_connection_ids: list[str] = []

    for c in connections:
        if c["id"] in claimed_connection_ids:
            continue
        if c.get("book") == "prop":
            prop_connection_ids.append(c["id"])
        else:
            self_directed_by_user.setdefault(c["user_id"], []).append(c["id"])

    memberships = [
        BookMembership("self_directed", user_id, ids) for user_id, ids in self_directed_by_user.items()
    ]
    memberships += [
        BookMembership("managed_client", trader_id, ids) for trader_id, ids in trader_connection_ids.items()
    ]
    if prop_connection_ids:
        memberships.append(BookMembership("prop", PROP_BOOK_SCOPE_ID, prop_connection_ids))

    return memberships
