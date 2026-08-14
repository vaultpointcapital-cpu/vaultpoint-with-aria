from app.value_ledger import emit_position_closed_events
from tests.conftest import FakeSupabase

CONNECTION = {"id": "conn-1", "user_id": "user-1"}


async def test_emits_one_rpc_call_per_stale_position():
    supabase = FakeSupabase()
    stale = [
        {"id": "row-1", "symbol": "BTCUSDT", "side": "long", "size": 1, "synced_at": "2026-08-01T00:00:00+00:00"},
        {"id": "row-2", "symbol": "ETHUSDT", "side": "short", "size": 2, "synced_at": "2026-08-01T00:05:00+00:00"},
    ]

    await emit_position_closed_events(supabase, CONNECTION, stale)

    assert len(supabase.rpc_calls) == 2
    assert all(c.fn_name == "value_ledger_apply_event" for c in supabase.rpc_calls)
    assert all(c.params["p_event_name"] == "position_closed" for c in supabase.rpc_calls)


async def test_idempotency_key_is_scoped_to_connection_symbol_side_and_sync_time():
    supabase = FakeSupabase()
    stale = [{"id": "row-1", "symbol": "BTCUSDT", "side": "long", "size": 1, "synced_at": "2026-08-01T00:00:00+00:00"}]

    await emit_position_closed_events(supabase, CONNECTION, stale)

    key = supabase.rpc_calls[0].params["p_idempotency_key"]
    assert key == "position_closed:conn-1:BTCUSDT:long:2026-08-01T00:00:00+00:00"


async def test_a_failed_emit_for_one_position_does_not_block_the_others():
    class ExplodingSupabase(FakeSupabase):
        def rpc(self, fn_name, params=None):
            is_btc_close = (
                params
                and params.get("p_event_name") == "position_closed"
                and params["p_properties"]["symbol"] == "BTCUSDT"
            )
            if is_btc_close:
                raise RuntimeError("simulated network failure")
            return super().rpc(fn_name, params)

    supabase = ExplodingSupabase()
    stale = [
        {"id": "row-1", "symbol": "BTCUSDT", "side": "long", "size": 1, "synced_at": "2026-08-01T00:00:00+00:00"},
        {"id": "row-2", "symbol": "ETHUSDT", "side": "short", "size": 2, "synced_at": "2026-08-01T00:05:00+00:00"},
    ]

    # Must not raise — signal_outcomes' own reconciliation continues
    # regardless of a value_ledger emit failure (see sync_service.py's
    # call site, same non-fatal posture as detect_and_record_outcomes).
    await emit_position_closed_events(supabase, CONNECTION, stale)

    assert len(supabase.rpc_calls) == 1
    assert supabase.rpc_calls[0].params["p_properties"]["symbol"] == "ETHUSDT"
