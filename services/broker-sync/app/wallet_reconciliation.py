"""Nightly wallet reconciliation (supabase/migrations/20260802000000_add_wallet.sql).

Diffs the wallet ledger against Paystack's and Stripe's own transaction
records for the prior 24h. Any mismatch is reported to Sentry — this job
never writes to wallets or wallet_transactions itself; balance corrections
are a human decision, not something a reconciliation job should make
silently (per the PRD's explicit "do not auto-correct balances" rule).

Crypto (web3) reconciliation is intentionally not implemented here — there
is no real off-ramp/custodian vendor chosen yet to reconcile against (see
src/lib/wallet/web3-adapter.ts), only a placeholder adapter. Add it once a
real vendor's transaction-list API exists.
"""

import logging
from datetime import UTC, datetime, timedelta

import httpx
import sentry_sdk

from .config import settings
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

PAYSTACK_API_BASE = "https://api.paystack.co"
STRIPE_API_BASE = "https://api.stripe.com/v1"


async def _fetch_local_wallet_references(since: datetime) -> set[str]:
    supabase = get_service_client()
    result = supabase.table("wallet_transactions").select("provider_reference, provider").eq("status", "completed").gte(
        "created_at", since.isoformat()
    ).in_("provider", ["paystack", "stripe"]).execute()
    return {row["provider_reference"] for row in result.data if row["provider_reference"]}


async def _fetch_paystack_successful_references(since: datetime) -> set[str]:
    if not settings.paystack_secret_key:
        logger.info("reconcile_wallet_transactions: PAYSTACK_SECRET_KEY not set — skipping Paystack leg")
        return set()

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{PAYSTACK_API_BASE}/transaction",
            headers={"Authorization": f"Bearer {settings.paystack_secret_key}"},
            params={"status": "success", "from": since.isoformat(), "perPage": 100},
        )
        response.raise_for_status()
        payload = response.json()

    return {
        tx["reference"]
        for tx in payload.get("data", [])
        # Only wallet deposits, not subscription charges — same
        # metadata.purpose marker set at initializePaystackDeposit().
        if (tx.get("metadata") or {}).get("purpose") == "wallet_deposit"
    }


async def _fetch_stripe_successful_references(since: datetime) -> set[str]:
    if not settings.stripe_secret_key:
        logger.info("reconcile_wallet_transactions: STRIPE_SECRET_KEY not set — skipping Stripe leg")
        return set()

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{STRIPE_API_BASE}/payment_intents",
            auth=(settings.stripe_secret_key, ""),
            params={"created[gte]": int(since.timestamp()), "limit": 100},
        )
        response.raise_for_status()
        payload = response.json()

    return {
        pi["id"]
        for pi in payload.get("data", [])
        if pi.get("status") == "succeeded" and (pi.get("metadata") or {}).get("purpose") == "wallet_deposit"
    }


async def reconcile_wallet_transactions() -> None:
    since = datetime.now(UTC) - timedelta(hours=24)

    local_references = await _fetch_local_wallet_references(since)
    paystack_references = await _fetch_paystack_successful_references(since)
    stripe_references = await _fetch_stripe_successful_references(since)

    remote_references = paystack_references | stripe_references
    missing_locally = remote_references - local_references

    if missing_locally:
        logger.error(
            "reconcile_wallet_transactions: %d confirmed provider deposit(s) missing from wallet_transactions: %s",
            len(missing_locally),
            sorted(missing_locally),
        )
        sentry_sdk.capture_message(
            f"Wallet reconciliation mismatch: {len(missing_locally)} confirmed deposit(s) "
            "not reflected in wallet_transactions",
            level="error",
        )
    else:
        logger.info("reconcile_wallet_transactions: no mismatches in the prior 24h window")
