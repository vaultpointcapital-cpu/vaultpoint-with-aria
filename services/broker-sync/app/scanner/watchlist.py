import asyncio


async def get_active_watchlist_symbols(supabase) -> list[dict]:
    result = await asyncio.to_thread(
        lambda: supabase.table("watchlist_symbols").select("*").eq("enabled", True).execute()
    )
    return result.data or []
