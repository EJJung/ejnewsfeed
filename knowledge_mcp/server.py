"""Knowledge Layer MCP server — read-only query tools over the ejnewsfeed
knowledge layer, for local Claude Code skills. Run: python -m knowledge_mcp.server
"""
from mcp.server.fastmcp import FastMCP

from knowledge_mcp import db, queries

mcp = FastMCP("knowledge")


@mcp.tool()
def search_insights(query: str | None = None, domains: list[str] | None = None,
                    status: list[str] | None = None, limit: int = 20) -> list[dict]:
    """Search insights by topic text (case-insensitive substring), filtered by
    domain and status. status defaults to active + contested."""
    rows = db.fetch_insights(
        queries.insight_status_filter(status), domains, queries.ilike_pattern(query), limit)
    return [queries.shape_insight(r) for r in rows]


@mcp.tool()
def get_contested(domains: list[str] | None = None) -> list[dict]:
    """Contested insights with their supporting vs contradicting sources."""
    return [queries.shape_contested(r) for r in db.fetch_contested(domains)]


@mcp.tool()
def knowledge_query(topic: str, domains: list[str] | None = None) -> dict:
    """What do we know about a topic: matching insights, open questions,
    decisions, and hypotheses in one consolidated result."""
    pattern = queries.ilike_pattern(topic)
    insights = [queries.shape_insight(r)
                for r in db.fetch_insights(queries.insight_status_filter(None), domains, pattern, 20)]
    oqs = [queries.shape_open_question(r) for r in db.fetch_open_questions("open", domains)
           if pattern is None or (topic.lower() in (r.get("question") or "").lower())]
    decs = [queries.shape_decision(r) for r in db.fetch_decisions("standing", domains)
            if pattern is None or (topic.lower() in (r.get("text") or "").lower())]
    hyps = [queries.shape_hypothesis(r) for r in db.fetch_hypotheses("open", domains)
            if pattern is None or (topic.lower() in (r.get("statement") or "").lower())]
    return queries.consolidate_knowledge(topic, insights, oqs, decs, hyps)


@mcp.tool()
def get_insight_sources(insight_id: str) -> dict:
    """A specific insight plus its full supporting/contradicting source list."""
    insight = db.fetch_insight(insight_id)
    if insight is None:
        return {"error": "insight not found"}
    return queries.shape_insight_with_sources(insight, db.fetch_insight_sources(insight_id))


@mcp.tool()
def get_open_questions(domains: list[str] | None = None, status: str = "open") -> list[dict]:
    """Open questions (default status 'open'), optionally filtered by domain."""
    return [queries.shape_open_question(r) for r in db.fetch_open_questions(status, domains)]


@mcp.tool()
def get_decisions(domains: list[str] | None = None, status: str = "standing") -> list[dict]:
    """Recorded decisions (default status 'standing'), optionally by domain."""
    return [queries.shape_decision(r) for r in db.fetch_decisions(status, domains)]


@mcp.tool()
def get_hypotheses(domains: list[str] | None = None, status: str = "open") -> list[dict]:
    """Hypotheses (default status 'open') with their for/against evidence."""
    out = []
    for row in db.fetch_hypotheses(status, domains):
        evidence = db.fetch_hypothesis_evidence(row["id"])
        out.append(queries.shape_hypothesis(row, evidence))
    return out


if __name__ == "__main__":
    mcp.run()
