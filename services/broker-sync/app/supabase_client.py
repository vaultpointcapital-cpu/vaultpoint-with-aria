from supabase import Client, create_client

from .config import settings


def get_service_client() -> Client:
    """Service-role client — bypasses RLS entirely. Only ever used
    server-side in this process; the key must never reach a frontend."""
    return create_client(settings.supabase_url, settings.supabase_service_role_key)
