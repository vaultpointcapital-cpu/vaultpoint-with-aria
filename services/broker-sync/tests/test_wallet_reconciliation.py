import pytest

from app import scheduler, wallet_reconciliation
from tests.conftest import FakeSupabase

# ---------------------------------------------------------------------------
# scheduler.reconcile_wallet_transactions — same lock/heartbeat/release
# contract as every other job (see test_scheduler.py), tested the same way:
# monkeypatch the module-level names scheduler.py imported, not internals.
# ---------------------------------------------------------------------------


async def test_reconcile_skips_entirely_when_lock_not_acquired(monkeypatch):
    business_calls = []
    heartbeat_calls = []
    release_calls = []

    async def _lock_held_elsewhere():
        return False

    async def _fake_business():
        business_calls.append(True)

    async def _fake_heartbeat():
        heartbeat_calls.append(True)

    async def _fake_release():
        release_calls.append(True)

    monkeypatch.setattr(scheduler, "acquire_wallet_reconciliation_lock", _lock_held_elsewhere)
    monkeypatch.setattr(scheduler, "_reconcile_wallet_transactions", _fake_business)
    monkeypatch.setattr(scheduler, "record_wallet_reconciliation_heartbeat", _fake_heartbeat)
    monkeypatch.setattr(scheduler, "release_wallet_reconciliation_lock", _fake_release)

    await scheduler.reconcile_wallet_transactions()

    assert business_calls == []
    assert heartbeat_calls == []
    # Never acquired, so must never attempt to release someone else's lock.
    assert release_calls == []


async def test_reconcile_runs_and_records_heartbeat_when_lock_acquired(monkeypatch):
    business_calls = []
    heartbeat_calls = []
    release_calls = []

    async def _lock_acquired():
        return True

    async def _fake_business():
        business_calls.append(True)

    async def _fake_heartbeat():
        heartbeat_calls.append(True)

    async def _fake_release():
        release_calls.append(True)

    monkeypatch.setattr(scheduler, "acquire_wallet_reconciliation_lock", _lock_acquired)
    monkeypatch.setattr(scheduler, "_reconcile_wallet_transactions", _fake_business)
    monkeypatch.setattr(scheduler, "record_wallet_reconciliation_heartbeat", _fake_heartbeat)
    monkeypatch.setattr(scheduler, "release_wallet_reconciliation_lock", _fake_release)

    await scheduler.reconcile_wallet_transactions()

    assert business_calls == [True]
    assert heartbeat_calls == [True]
    assert release_calls == [True]


async def test_reconcile_releases_lock_even_if_business_logic_raises(monkeypatch):
    """The lock must not be left held if the diff itself blows up —
    otherwise a single bad cycle would block every future cycle until the
    TTL safety net expires, same guarantee as every other scheduled job."""
    heartbeat_calls = []
    release_calls = []

    async def _lock_acquired():
        return True

    async def _raising_business():
        raise RuntimeError("boom")

    async def _fake_heartbeat():
        heartbeat_calls.append(True)

    async def _fake_release():
        release_calls.append(True)

    monkeypatch.setattr(scheduler, "acquire_wallet_reconciliation_lock", _lock_acquired)
    monkeypatch.setattr(scheduler, "_reconcile_wallet_transactions", _raising_business)
    monkeypatch.setattr(scheduler, "record_wallet_reconciliation_heartbeat", _fake_heartbeat)
    monkeypatch.setattr(scheduler, "release_wallet_reconciliation_lock", _fake_release)

    with pytest.raises(RuntimeError):
        await scheduler.reconcile_wallet_transactions()

    assert release_calls == [True]
    assert heartbeat_calls == []


# ---------------------------------------------------------------------------
# wallet_reconciliation.reconcile_wallet_transactions — the actual diff
# logic. Provider fetches are monkeypatched directly (no real Paystack/
# Stripe secret keys or HTTP calls in a unit test); only the diff and its
# Sentry reporting are under test here.
# ---------------------------------------------------------------------------


async def test_no_mismatch_does_not_report_to_sentry(monkeypatch):
    supabase = FakeSupabase()
    monkeypatch.setattr(wallet_reconciliation, "get_service_client", lambda: supabase)

    async def _local(since):
        return {"ref-1", "ref-2"}

    async def _paystack(since):
        return {"ref-1"}

    async def _stripe(since):
        return {"ref-2"}

    capture_calls = []

    def _fake_capture(*args, **kwargs):
        capture_calls.append((args, kwargs))

    monkeypatch.setattr(wallet_reconciliation, "_fetch_local_wallet_references", _local)
    monkeypatch.setattr(wallet_reconciliation, "_fetch_paystack_successful_references", _paystack)
    monkeypatch.setattr(wallet_reconciliation, "_fetch_stripe_successful_references", _stripe)
    monkeypatch.setattr(wallet_reconciliation.sentry_sdk, "capture_message", _fake_capture)

    await wallet_reconciliation.reconcile_wallet_transactions()

    assert capture_calls == []


async def test_confirmed_deposit_missing_locally_reports_to_sentry(monkeypatch):
    """The core guarantee this job exists for: a provider-confirmed deposit
    that never landed in wallet_transactions (e.g. a dropped webhook) must
    be surfaced, not silently missed — and the job must never attempt to
    fix it itself."""

    async def _local(since):
        return {"ref-1"}  # only ref-1 made it into the ledger

    async def _paystack(since):
        return {"ref-1", "ref-2"}  # Paystack confirms ref-2 too

    async def _stripe(since):
        return set()

    capture_calls = []

    def _fake_capture(*args, **kwargs):
        capture_calls.append((args, kwargs))

    monkeypatch.setattr(wallet_reconciliation, "_fetch_local_wallet_references", _local)
    monkeypatch.setattr(wallet_reconciliation, "_fetch_paystack_successful_references", _paystack)
    monkeypatch.setattr(wallet_reconciliation, "_fetch_stripe_successful_references", _stripe)
    monkeypatch.setattr(wallet_reconciliation.sentry_sdk, "capture_message", _fake_capture)

    await wallet_reconciliation.reconcile_wallet_transactions()

    assert len(capture_calls) == 1
    message = capture_calls[0][0][0]
    assert "1" in message
