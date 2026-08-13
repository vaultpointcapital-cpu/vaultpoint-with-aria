import pytest

from app.portfolio_risk import scope, service
from tests.conftest import FakeSupabase

POSITIONS_COLUMNS = "symbol, side, size, entry_price, mark_price, unrealized_pnl, margin_used, broker_connection_id"


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(service, "get_service_client", lambda: fake)
    return fake


@pytest.fixture
def stub_notify(monkeypatch):
    calls = []

    async def fake_notify(user_id, book_label, drawdown_pct):
        calls.append((user_id, book_label, drawdown_pct))

    monkeypatch.setattr(service.connection_health_notifications, "notify_book_circuit_breaker_tripped", fake_notify)
    return calls


def _seed_self_directed_book(fake: FakeSupabase, *, unrealized_pnl: float, margin_used: float = 10000) -> None:
    fake.select_responses[("broker_connections", "id, user_id, book")] = [
        {"id": "conn-1", "user_id": "user-1", "book": "self_directed"}
    ]
    fake.select_responses[("managed_sub_accounts", "id, trader_id, broker_connection_id")] = []
    fake.select_responses[("fx_rates", "currency, rate_to_usd")] = []
    fake.select_responses[("positions", POSITIONS_COLUMNS)] = [
        {
            "symbol": "BTCUSDT",
            "side": "long",
            "size": 1,
            "entry_price": 60000,
            "mark_price": 59200,
            "unrealized_pnl": unrealized_pnl,
            "margin_used": margin_used,
            "broker_connection_id": "conn-1",
        }
    ]
    fake.select_responses[("book_risk_state", "*")] = []


class TestCircuitBreakerTripping:
    async def test_trips_exactly_at_threshold(self, fake_supabase, monkeypatch, stub_notify):
        monkeypatch.setattr(service.settings, "portfolio_risk_monthly_drawdown_circuit_breaker_pct", 8.0)
        _seed_self_directed_book(fake_supabase, unrealized_pnl=-800, margin_used=10000)  # exactly -8%

        await service.evaluate_portfolio_risk()

        updates = fake_supabase.calls_for("book_risk_state", "update")
        tripped_updates = [u for u in updates if u.values.get("tripped") is True]
        assert len(tripped_updates) == 1

    async def test_does_not_trip_just_above_threshold(self, fake_supabase, monkeypatch, stub_notify):
        monkeypatch.setattr(service.settings, "portfolio_risk_monthly_drawdown_circuit_breaker_pct", 8.0)
        _seed_self_directed_book(fake_supabase, unrealized_pnl=-799, margin_used=10000)  # -7.99%, not past threshold

        await service.evaluate_portfolio_risk()

        updates = fake_supabase.calls_for("book_risk_state", "update")
        tripped_updates = [u for u in updates if u.values.get("tripped") is True]
        assert tripped_updates == []

    async def test_tripped_book_stays_tripped_across_month_rollover(self, fake_supabase):
        fake_supabase.select_responses[("broker_connections", "id, user_id, book")] = [
            {"id": "conn-1", "user_id": "user-1", "book": "self_directed"}
        ]
        fake_supabase.select_responses[("managed_sub_accounts", "id, trader_id, broker_connection_id")] = []
        fake_supabase.select_responses[("fx_rates", "currency, rate_to_usd")] = []
        fake_supabase.select_responses[("positions", POSITIONS_COLUMNS)] = []
        fake_supabase.select_responses[("book_risk_state", "*")] = [
            {
                "id": "risk-1",
                "book_type": "self_directed",
                "book_scope_id": "user-1",
                "baseline_equity": 10000,
                "baseline_source": "position_proxy",
                "baseline_period_start": "2026-01-01",  # a prior calendar month
                "tripped": True,
                "current_drawdown_pct": -12.0,
            }
        ]

        await service.evaluate_portfolio_risk()

        # No auto re-enable: neither a baseline-rollover update nor a
        # fresh insert should ever happen for an already-tripped book.
        assert fake_supabase.calls_for("book_risk_state", "update") == []
        assert fake_supabase.calls_for("book_risk_state", "insert") == []


class TestValueLedgerFanOut:
    async def test_one_apply_event_call_per_affected_user_not_one_for_the_whole_book(
        self, fake_supabase, monkeypatch, stub_notify
    ):
        monkeypatch.setattr(service.settings, "portfolio_risk_monthly_drawdown_circuit_breaker_pct", 8.0)

        fake_supabase.select_responses[("broker_connections", "id, user_id, book")] = []
        fake_supabase.select_responses[("managed_sub_accounts", "id, trader_id, broker_connection_id")] = [
            {"id": "sub-1", "trader_id": "trader-1", "broker_connection_id": "conn-1"},
            {"id": "sub-2", "trader_id": "trader-1", "broker_connection_id": "conn-2"},
            {"id": "sub-3", "trader_id": "trader-1", "broker_connection_id": "conn-3"},
        ]
        fake_supabase.select_responses[("managed_sub_accounts", "allocated_amount")] = [
            {"allocated_amount": 1000},
            {"allocated_amount": 1000},
            {"allocated_amount": 1000},
        ]
        fake_supabase.select_responses[("fx_rates", "currency, rate_to_usd")] = []
        fake_supabase.select_responses[("positions", POSITIONS_COLUMNS)] = [
            {
                "symbol": "BTCUSDT",
                "side": "long",
                "size": 1,
                "entry_price": 60000,
                "mark_price": 59500,
                "unrealized_pnl": -500,  # -16.7% against a 3000 baseline — well past -8%
                "margin_used": 1000,
                "broker_connection_id": "conn-1",
            }
        ]
        fake_supabase.select_responses[("book_risk_state", "*")] = []
        fake_supabase.select_responses[("managed_traders", "user_id")] = [{"user_id": "trader-owner-1"}]
        fake_supabase.select_responses[("managed_sub_accounts", "client_user_id")] = [
            {"client_user_id": "client-1"},
            {"client_user_id": "client-2"},
            {"client_user_id": "client-3"},
        ]

        await service.evaluate_portfolio_risk()

        assert len(fake_supabase.rpc_calls) == 4  # trader owner + 3 clients, not 1 call for the whole book
        assert all(call.fn_name == "value_ledger_apply_event" for call in fake_supabase.rpc_calls)
        user_ids = {call.params["p_user_id"] for call in fake_supabase.rpc_calls}
        assert user_ids == {"trader-owner-1", "client-1", "client-2", "client-3"}

    async def test_prop_book_trip_emits_no_ledger_events(self, fake_supabase, monkeypatch, stub_notify):
        # Track A has zero real rows today — a 'prop' membership should
        # never actually surface here since enumerate_active_books only
        # emits one if prop_connection_ids is non-empty, but this
        # confirms _affected_user_ids' own no-op path doesn't error if it
        # ever does.
        monkeypatch.setattr(service.settings, "portfolio_risk_monthly_drawdown_circuit_breaker_pct", 8.0)
        membership = scope.BookMembership("prop", scope.PROP_BOOK_SCOPE_ID, ["conn-1"])
        fake_supabase.select_responses[("positions", POSITIONS_COLUMNS)] = [
            {
                "symbol": "BTCUSDT",
                "side": "long",
                "size": 1,
                "entry_price": 60000,
                "mark_price": 59000,
                "unrealized_pnl": -1000,
                "margin_used": 1000,
                "broker_connection_id": "conn-1",
            }
        ]
        fake_supabase.select_responses[("fx_rates", "currency, rate_to_usd")] = []
        fake_supabase.select_responses[("book_risk_state", "*")] = []

        await service._evaluate_book(fake_supabase, membership, {})

        assert fake_supabase.rpc_calls == []
        assert stub_notify == []


class TestEnumerateActiveBooks:
    async def test_connection_claimed_by_managed_sub_account_excluded_from_self_directed(self, fake_supabase):
        fake_supabase.select_responses[("broker_connections", "id, user_id, book")] = [
            {"id": "conn-1", "user_id": "user-1", "book": "self_directed"},
            {"id": "conn-2", "user_id": "user-1", "book": "self_directed"},
        ]
        fake_supabase.select_responses[("managed_sub_accounts", "id, trader_id, broker_connection_id")] = [
            {"id": "sub-1", "trader_id": "trader-1", "broker_connection_id": "conn-2"},
        ]

        memberships = await scope.enumerate_active_books(fake_supabase)

        self_directed = next(m for m in memberships if m.book_type == "self_directed")
        assert self_directed.connection_ids == ["conn-1"]

        managed_client = next(m for m in memberships if m.book_type == "managed_client")
        assert managed_client.connection_ids == ["conn-2"]

    async def test_prop_connections_grouped_under_the_shared_sentinel_scope(self, fake_supabase):
        fake_supabase.select_responses[("broker_connections", "id, user_id, book")] = [
            {"id": "conn-1", "user_id": "user-1", "book": "prop"},
            {"id": "conn-2", "user_id": "user-2", "book": "prop"},
        ]
        fake_supabase.select_responses[("managed_sub_accounts", "id, trader_id, broker_connection_id")] = []

        memberships = await scope.enumerate_active_books(fake_supabase)

        prop = next(m for m in memberships if m.book_type == "prop")
        assert prop.book_scope_id == scope.PROP_BOOK_SCOPE_ID
        assert set(prop.connection_ids) == {"conn-1", "conn-2"}

    async def test_no_prop_membership_when_no_prop_connections_exist(self, fake_supabase):
        fake_supabase.select_responses[("broker_connections", "id, user_id, book")] = [
            {"id": "conn-1", "user_id": "user-1", "book": "self_directed"},
        ]
        fake_supabase.select_responses[("managed_sub_accounts", "id, trader_id, broker_connection_id")] = []

        memberships = await scope.enumerate_active_books(fake_supabase)

        assert not any(m.book_type == "prop" for m in memberships)
