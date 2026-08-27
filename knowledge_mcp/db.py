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


INSIGHT_COLS = "id, text, domains, confidence, status, first_seen_at, last_confirmed_at"
SOURCE_SELECT = "relation, article:articles(title, url, source:sources(name))"


def fetch_insights(status, domains, pattern, limit):
    q = get_client().table("insights").select(INSIGHT_COLS).in_("status", status)
    if pattern:
        q = q.ilike("text", pattern)
    if domains:
        q = q.overlaps("domains", domains)
    return q.order("first_seen_at", desc=True).limit(limit).execute().data


def fetch_insight(insight_id):
    rows = get_client().table("insights").select(INSIGHT_COLS).eq("id", insight_id).execute().data
    return rows[0] if rows else None


def fetch_insight_sources(insight_id):
    return (
        get_client().table("insight_sources").select(SOURCE_SELECT)
        .eq("insight_id", insight_id).execute().data
    )


def fetch_contested(domains):
    q = (
        get_client().table("insights")
        .select(f"id, text, domains, confidence, insight_sources({SOURCE_SELECT})")
        .eq("status", "contested")
    )
    if domains:
        q = q.overlaps("domains", domains)
    return q.execute().data


def fetch_open_questions(status, domains):
    q = get_client().table("open_questions").select(
        "id, question, why_it_matters, domains, status").eq("status", status)
    if domains:
        q = q.overlaps("domains", domains)
    return q.execute().data


def fetch_decisions(status, domains):
    q = get_client().table("decisions").select(
        "id, text, context, domains, decided_at, status").eq("status", status)
    if domains:
        q = q.overlaps("domains", domains)
    return q.execute().data


def fetch_hypotheses(status, domains):
    q = get_client().table("hypotheses").select(
        "id, statement, domains, status").eq("status", status)
    if domains:
        q = q.overlaps("domains", domains)
    return q.execute().data


def fetch_hypothesis_evidence(hypothesis_id):
    return (
        get_client().table("hypothesis_evidence").select("stance, insight:insights(text)")
        .eq("hypothesis_id", hypothesis_id).execute().data
    )
