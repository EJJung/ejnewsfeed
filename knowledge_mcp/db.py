"""Thin Supabase access for the knowledge MCP server (read-only)."""
import os
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client, Client

_client: Client | None = None


def get_client() -> Client:
    """Return a cached Supabase client, configured from knowledge_mcp/.env."""
    global _client
    if _client is None:
        load_dotenv(Path(__file__).parent / ".env")
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client
